import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage, type Model } from "@gajae-code/ai";
import { Settings } from "../src/config/settings";
import {
	createSdkHostModelRegistryLoader,
	resolveSdkHostModel,
	type SdkHostModelRegistryLoader,
} from "../src/sdk/host/model-pin";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const registryWith = (models: Model[]): SdkHostModelRegistryLoader =>
	(() => ({ getAll: () => models })) as unknown as SdkHostModelRegistryLoader;

const CURSOR_MODELS = [
	model("cursor", "claude-fable-5-xhigh"),
	model("cursor", "composer-2.5"),
	model("cursor", "default"),
];

describe("resolveSdkHostModel", () => {
	it("treats an absent value as no pin", async () => {
		for (const absent of [undefined, null]) {
			expect(await resolveSdkHostModel(absent, registryWith(CURSOR_MODELS))).toEqual({
				ok: true,
				model: null,
			});
		}
	});

	it("resolves every Cursor id from the issue with CLI parity", async () => {
		for (const selector of ["cursor/claude-fable-5-xhigh", "cursor/composer-2.5", "cursor/default"]) {
			expect(await resolveSdkHostModel(selector, registryWith(CURSOR_MODELS))).toEqual({
				ok: true,
				model: selector,
			});
		}
		expect(await resolveSdkHostModel("cursor/default:high", registryWith(CURSOR_MODELS))).toEqual({
			ok: true,
			model: "cursor/default:high",
		});
	});

	it("fails closed on unknown ids with the CLI not-found error", async () => {
		const rejected = await resolveSdkHostModel("cursor:fable5-xhigh", registryWith(CURSOR_MODELS));
		expect(rejected).toEqual({
			ok: false,
			reason: "unknown_model",
			model: "cursor:fable5-xhigh",
			error: 'Model "cursor:fable5-xhigh" not found. Use --list-models to see available models.',
		});
	});

	it("fails closed when no models are available at all", async () => {
		const rejected = await resolveSdkHostModel("cursor/default", registryWith([]));
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) {
			expect(rejected.reason).toBe("unknown_model");
			expect(rejected.error).toContain("No models available");
		}
	});

	it("resolves against the full registry, not the authenticated-only subset", async () => {
		const loader = registryWith(CURSOR_MODELS);
		expect(await resolveSdkHostModel("cursor/default", loader)).toEqual({
			ok: true,
			model: "cursor/default",
		});
	});

	it("pins the concrete provider/id the selector resolved to, not a bare alias", async () => {
		const loader = registryWith([model("cursor", "composer-2.5"), model("openai", "composer-2.5")]);
		const resolved = await resolveSdkHostModel("cursor/composer-2.5", loader);
		expect(resolved).toEqual({ ok: true, model: "cursor/composer-2.5" });
	});

	it("refreshes the registry on every validation instead of caching one snapshot", async () => {
		const storage = await AuthStorage.create(":memory:");
		let discoveries = 0;
		const loader = createSdkHostModelRegistryLoader(async () => {
			discoveries += 1;
			return storage;
		});
		try {
			const first = await loader();
			const refresh = vi.spyOn(first, "refresh");
			const second = await loader();
			const third = await loader();

			expect(second).toBe(first);
			expect(third).toBe(first);
			expect(discoveries).toBe(1);
			expect(refresh.mock.calls).toEqual([["offline"], ["offline"]]);
			expect(first.getAll().length).toBeGreaterThan(0);
		} finally {
			await loader.dispose?.();
			storage.close();
		}
	});

	it("judges each validation against the registry contents at that moment", async () => {
		let models: Model[] = [model("cursor", "default")];
		const loader = (() => ({ getAll: () => models })) as unknown as SdkHostModelRegistryLoader;

		expect(await resolveSdkHostModel("cursor/default", loader)).toEqual({ ok: true, model: "cursor/default" });
		expect((await resolveSdkHostModel("cursor/composer-2.5", loader)).ok).toBe(false);

		models = [model("cursor", "composer-2.5")];
		expect(await resolveSdkHostModel("cursor/composer-2.5", loader)).toEqual({
			ok: true,
			model: "cursor/composer-2.5",
		});
		expect((await resolveSdkHostModel("cursor/default", loader)).ok).toBe(false);
	});

	it("binds each registry to its explicit models path", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-host-model-paths-"));
		const firstStorage = await AuthStorage.create(path.join(root, "first-auth.db"));
		const secondStorage = await AuthStorage.create(path.join(root, "second-auth.db"));
		const firstModelsPath = path.join(root, "first", "models.yml");
		const secondModelsPath = path.join(root, "second", "models.yml");
		const modelsFile = (id: string) =>
			`providers:\n  fixture:\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: ${id}\n        name: ${id}\n        contextWindow: 32768\n        maxTokens: 4096\n`;
		try {
			await fs.mkdir(path.dirname(firstModelsPath), { recursive: true });
			await fs.mkdir(path.dirname(secondModelsPath), { recursive: true });
			await fs.writeFile(firstModelsPath, modelsFile("first-model"));
			await fs.writeFile(secondModelsPath, modelsFile("second-model"));

			const firstLoader = createSdkHostModelRegistryLoader(async () => firstStorage, firstModelsPath);
			const secondLoader = createSdkHostModelRegistryLoader(async () => secondStorage, secondModelsPath);
			expect(await resolveSdkHostModel("fixture/first-model", firstLoader)).toEqual({
				ok: true,
				model: "fixture/first-model",
			});
			expect((await resolveSdkHostModel("fixture/second-model", firstLoader)).ok).toBe(false);
			expect(await resolveSdkHostModel("fixture/second-model", secondLoader)).toEqual({
				ok: true,
				model: "fixture/second-model",
			});
			expect((await resolveSdkHostModel("fixture/first-model", secondLoader)).ok).toBe(false);
		} finally {
			firstStorage.close();
			secondStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("binds canonical alias ranking to each registry's provider order", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-host-provider-order-"));
		const firstStorage = await AuthStorage.create(path.join(root, "first-auth.db"));
		const secondStorage = await AuthStorage.create(path.join(root, "second-auth.db"));
		const modelsPath = path.join(root, "models.yml");
		const modelsFile = `providers:
  fixture-a:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: fixture-key
    api: openai-completions
    models:
      - id: shared
        name: shared
        contextWindow: 32768
        maxTokens: 4096
  fixture-b:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: fixture-key
    api: openai-completions
    models:
      - id: shared
        name: shared
        contextWindow: 32768
        maxTokens: 4096
`;
		try {
			await fs.writeFile(modelsPath, modelsFile);
			const firstLoader = createSdkHostModelRegistryLoader(
				async () => firstStorage,
				modelsPath,
				async () => Settings.isolated({ modelProviderOrder: ["fixture-b"] }),
			);
			const secondLoader = createSdkHostModelRegistryLoader(
				async () => secondStorage,
				modelsPath,
				async () => Settings.isolated({ modelProviderOrder: ["fixture-a"] }),
			);

			expect(await resolveSdkHostModel("shared", firstLoader)).toEqual({
				ok: true,
				model: "fixture-b/shared",
			});
			expect(await resolveSdkHostModel("shared", secondLoader)).toEqual({
				ok: true,
				model: "fixture-a/shared",
			});
		} finally {
			firstStorage.close();
			secondStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reloads provider order while a broker registry remains alive", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-host-provider-order-reload-"));
		const storage = await AuthStorage.create(path.join(root, "auth.db"));
		const modelsPath = path.join(root, "models.yml");
		await fs.writeFile(
			modelsPath,
			`providers:
  fixture-a:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: fixture-key
    api: openai-completions
    models:
      - id: shared
        name: shared
        contextWindow: 32768
        maxTokens: 4096
  fixture-b:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: fixture-key
    api: openai-completions
    models:
      - id: shared
        name: shared
        contextWindow: 32768
        maxTokens: 4096
`,
		);
		let order = ["fixture-b"];
		const loader = createSdkHostModelRegistryLoader(
			async () => storage,
			modelsPath,
			async () => Settings.isolated({ modelProviderOrder: order }),
		);
		try {
			expect(await resolveSdkHostModel("shared", loader)).toEqual({
				ok: true,
				model: "fixture-b/shared",
			});
			order = ["fixture-a"];
			expect(await resolveSdkHostModel("shared", loader)).toEqual({
				ok: true,
				model: "fixture-a/shared",
			});
		} finally {
			storage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps concurrent workspace validations isolated", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-host-provider-order-concurrent-"));
		const storage = await AuthStorage.create(path.join(root, "auth.db"));
		const modelsPath = path.join(root, "models.yml");
		await fs.writeFile(
			modelsPath,
			`providers:
  fixture-a:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: fixture-key
    api: openai-completions
    models:
      - id: shared
        name: shared
        contextWindow: 32768
        maxTokens: 4096
  fixture-b:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: fixture-key
    api: openai-completions
    models:
      - id: shared
        name: shared
        contextWindow: 32768
        maxTokens: 4096
`,
		);
		const workspaceA = path.join(root, "workspace-a");
		const workspaceB = path.join(root, "workspace-b");
		let settingsLoads = 0;
		const loader = createSdkHostModelRegistryLoader(
			async () => storage,
			modelsPath,
			async context => {
				settingsLoads += 1;
				if (context?.cwd === workspaceA) await Bun.sleep(20);
				return Settings.isolated({ modelProviderOrder: [context?.cwd === workspaceA ? "fixture-a" : "fixture-b"] });
			},
		);
		try {
			const [resolvedA, resolvedB] = await Promise.all([
				resolveSdkHostModel("shared", loader, { cwd: workspaceA }),
				resolveSdkHostModel("shared", loader, { cwd: workspaceB }),
			]);
			expect(resolvedA).toEqual({ ok: true, model: "fixture-a/shared" });
			expect(resolvedB).toEqual({ ok: true, model: "fixture-b/shared" });
			expect(settingsLoads).toBeGreaterThanOrEqual(2);
		} finally {
			storage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("retries registry initialization after a transient failure", async () => {
		const storage = await AuthStorage.create(":memory:");
		let attempts = 0;
		const loader = createSdkHostModelRegistryLoader(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient storage failure");
			return storage;
		});
		try {
			await expect(resolveSdkHostModel("cursor/default", loader)).rejects.toThrow("transient storage failure");
			expect(await resolveSdkHostModel("cursor/default", loader)).toEqual({ ok: true, model: "cursor/default" });
			expect(attempts).toBe(2);
		} finally {
			storage.close();
		}
	});
});
