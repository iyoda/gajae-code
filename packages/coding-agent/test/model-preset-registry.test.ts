import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	canonicalModelPresetRegistryJson,
	getModelPresetRegistryStatus,
	loadAcceptedModelPresetRegistry,
	MODEL_PRESET_REGISTRY_TRUSTED_KEYS,
	type ModelPresetRegistryManifest,
	type ModelPresetRegistryPresets,
	type ModelPresetRegistryProfiles,
	type ModelPresetRegistrySnapshot,
	type ModelPresetRegistryTrustedKey,
	refreshModelPresetRegistry,
	rollbackModelPresetRegistry,
	setModelPresetRegistryDisabled,
	setModelPresetRegistryPin,
} from "../src/config/model-preset-registry";
import { mergeModelProfiles } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { loadCoordinatorModelProfiles } from "../src/coordinator-mcp/model-preset";
import { validateBrokerModelPresetForTest } from "../src/sdk/broker/lifecycle";
import { AuthStorage } from "../src/session/auth-storage";

const directories: string[] = [];
setDefaultTimeout(30_000);
const manifestUrl = "https://presets.gajae-code.test/latest.json";
const productionManifestV1 = `{"schemaVersion":"1.0.0","signature":{"algorithm":"Ed25519","keyId":"registry-root-2026-01","value":"72hjU+GP8jsfCft0XotlRDhBa1sxPGPzySVATT1wwdT/h3Cb+Ylj7DI0ydiiAqSbDtFPhOmZvhFxpLeUQ5jFBw=="},"signed":{"compatibility":{"consumerContract":{"maxVersion":"1.0.0","minVersion":"1.0.0"}},"contents":{"presets":{"bytes":1230434,"count":4271,"path":"revisions/00000001/presets.json","sha256":"a73a9d0876198475902e7b87ac59dce37746025b35711767bd7ba6afe4104d96"},"profiles":{"bytes":19679,"count":58,"path":"revisions/00000001/profiles.json","sha256":"8befc86c52621d18f71ad141cd194329e8299bcfd50772faaf68b7f9c5b379cd"}},"provenance":{"generatedAt":"2026-08-24T09:41:42.000Z","generatedBy":"gajae-code-presets/scripts/import-upstream.mjs@1","sourcePaths":["packages/ai/src/models.json","packages/coding-agent/src/config/model-profiles.ts"],"sourceRepository":"https://github.com/Yeachan-Heo/gajae-code","sourceRevision":"65d0d2fdae36a4512959a6a8c143339b8ec98c58"},"publishedAt":"2026-08-24T09:41:42.000Z","registryRevision":1,"revision":"00000001","snapshot":{"bytes":819,"count":1,"path":"revisions/00000001/snapshot.json","sha256":"3e3e9e8d114be2b29184b83ed9c3321902a48202cda14ec765a73298c383c030"}}}`;
const productionSnapshotV1 = `{"compatibility":{"consumerContract":{"maxVersion":"1.0.0","minVersion":"1.0.0"}},"contents":{"presets":{"bytes":1230434,"count":4271,"path":"revisions/00000001/presets.json","sha256":"a73a9d0876198475902e7b87ac59dce37746025b35711767bd7ba6afe4104d96"},"profiles":{"bytes":19679,"count":58,"path":"revisions/00000001/profiles.json","sha256":"8befc86c52621d18f71ad141cd194329e8299bcfd50772faaf68b7f9c5b379cd"}},"provenance":{"generatedAt":"2026-08-24T09:41:42.000Z","generatedBy":"gajae-code-presets/scripts/import-upstream.mjs@1","sourcePaths":["packages/ai/src/models.json","packages/coding-agent/src/config/model-profiles.ts"],"sourceRepository":"https://github.com/Yeachan-Heo/gajae-code","sourceRevision":"65d0d2fdae36a4512959a6a8c143339b8ec98c58"},"registryRevision":1,"revision":"00000001","schemaVersion":"1.0.0"}`;

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}
function descriptor(pathname: string, body: string, count: number) {
	return { path: pathname, sha256: sha256(body), bytes: Buffer.byteLength(body), count };
}
function registryProfile(id: string, selector = "provider/remote-model") {
	return {
		id,
		displayName: id,
		providerGroup: "TEST",
		requiredProviders: ["provider"],
		roleBindings: { default: selector },
	};
}
function registryPreset(id: string, contextWindow = 8192) {
	return {
		id,
		provider: "provider",
		name: id,
		api: "openai-completions" as const,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 2048,
	};
}
async function fixture() {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-preset-registry-"));
	directories.push(agentDir);
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	const trustedKey: ModelPresetRegistryTrustedKey = {
		keyId: "test-key",
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		validFrom: "2026-01-01T00:00:00.000Z",
	};
	return { agentDir, privateKey, trustedKeys: new Map([[trustedKey.keyId, trustedKey]]) };
}

function signedRegistry(
	privateKey: crypto.KeyObject,
	revision: number,
	profileEntries = [registryProfile("remote")],
	presetEntries = [registryPreset("remote-model")],
	compatibility = { consumerContract: { minVersion: "1.0.0", maxVersion: "1.0.0" } },
	dynamicProviders: string[] = [],
) {
	const revisionId = String(revision).padStart(8, "0");
	const profiles: ModelPresetRegistryProfiles = {
		schemaVersion: "1.0.0",
		revision: revisionId,
		dynamicProviders,
		profiles: profileEntries,
	};
	const presets: ModelPresetRegistryPresets = {
		schemaVersion: "1.0.0",
		revision: revisionId,
		presets: presetEntries,
	};
	const profilesBody = canonicalModelPresetRegistryJson(profiles);
	const presetsBody = canonicalModelPresetRegistryJson(presets);
	const contents = {
		profiles: descriptor(`revisions/${revisionId}/profiles.json`, profilesBody, profiles.profiles.length),
		presets: descriptor(`revisions/${revisionId}/presets.json`, presetsBody, presets.presets.length),
	};
	const provenance = {
		sourceRepository: "https://github.com/Yeachan-Heo/gajae-code" as const,
		sourceRevision: "65d0d2fdae36a4512959a6a8c143339b8ec98c58",
		sourcePaths: ["packages/coding-agent/src/config/model-profiles.ts"],
		generatedBy: "test@1",
		generatedAt: "2026-08-24T09:41:42.000Z",
	};
	const snapshot: ModelPresetRegistrySnapshot = {
		schemaVersion: "1.0.0",
		registryRevision: revision,
		revision: revisionId,
		compatibility,
		provenance,
		contents,
	};
	const snapshotBody = canonicalModelPresetRegistryJson(snapshot);
	const signed = {
		registryRevision: revision,
		revision: revisionId,
		publishedAt: "2026-08-24T09:41:42.000Z",
		compatibility,
		snapshot: descriptor(`revisions/${revisionId}/snapshot.json`, snapshotBody, 1),
		contents,
		provenance,
	};
	const signature = crypto
		.sign(null, Buffer.from(canonicalModelPresetRegistryJson(signed)), privateKey)
		.toString("base64");
	const manifest: ModelPresetRegistryManifest = {
		schemaVersion: "1.0.0",
		signed,
		signature: { algorithm: "Ed25519", keyId: "test-key", value: signature },
	};
	return {
		manifest,
		manifestBody: canonicalModelPresetRegistryJson(manifest),
		snapshot,
		snapshotBody,
		profiles,
		profilesBody,
		presets,
		presetsBody,
	};
}

function registryFetch(registry: ReturnType<typeof signedRegistry>, observedHeaders?: Headers[]): typeof fetch {
	let calls = 0;
	return (async (_input, init) => {
		calls++;
		observedHeaders?.push(new Headers(init?.headers));
		if (calls === 1) return new Response(registry.manifestBody, { headers: { etag: '"revision"' } });
		if (calls === 2) return new Response(registry.snapshotBody);
		if (calls === 3) return new Response(registry.profilesBody);
		return new Response(registry.presetsBody);
	}) as typeof fetch;
}
async function accept(
	data: Awaited<ReturnType<typeof fixture>>,
	registry: ReturnType<typeof signedRegistry>,
	fetchImpl = registryFetch(registry),
) {
	return refreshModelPresetRegistry({
		agentDir: data.agentDir,
		manifestUrl,
		trustedKeys: data.trustedKeys,
		fetch: fetchImpl,
		allowTestUrls: true,
	});
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("signed model preset registry", () => {
	test("matches producer canonical JSON ordering and rejects lone surrogates", () => {
		expect(canonicalModelPresetRegistryJson({ "\ue000": 1, 𐀀: 2, negativeZero: -0 })).toBe(
			'{"negativeZero":0,"𐀀":2,"":1}',
		);
		expect(() => canonicalModelPresetRegistryJson("\ud800")).toThrow(/lone high surrogate/i);
	});

	test("accepts the exact producer revision-1 manifest signature and snapshot binding", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-preset-production-contract-"));
		directories.push(agentDir);
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			if (calls === 1) return new Response(productionManifestV1);
			if (calls === 2) return new Response(productionSnapshotV1);
			return new Response("");
		}) as unknown as typeof fetch;
		await expect(
			refreshModelPresetRegistry({ agentDir, manifestUrl, fetch: fetchImpl, allowTestUrls: true }),
		).rejects.toThrow(/profiles size mismatch/i);
		expect(calls).toBe(3);
		expect(getModelPresetRegistryStatus({ agentDir })).toMatchObject({ cacheHealth: "empty", source: "embedded" });
	});

	test("accepts the exact signed manifest/snapshot/content contract and merges embedded < registry < user", async () => {
		const data = await fixture();
		const registry = signedRegistry(
			data.privateKey,
			1,
			[registryProfile("codex-medium", "provider/remote-model"), registryProfile("remote")],
			[
				registryPreset("remote-model"),
				{ ...registryPreset("MiniMax-M2.5", 12_345), provider: "alibaba-token-plan" },
				{ ...registryPreset("registry-only-model", 24_680), provider: "alibaba-token-plan" },
			],
		);
		expect(await accept(data, registry)).toMatchObject({ status: "updated", revision: 1, revisionId: "00000001" });
		expect(await Bun.file(path.join(data.agentDir, "models.yml")).exists()).toBe(false);
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys });
		expect(accepted.profiles.get("remote")?.source).toBe("registry");
		expect(accepted.presets).toEqual(
			expect.arrayContaining([expect.objectContaining({ provider: "provider", id: "remote-model" })]),
		);
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "auth.db"));
		try {
			const modelRegistry = new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
				trustedKeys: data.trustedKeys,
				allowTestUrls: true,
				automaticRefresh: false,
			});
			expect(modelRegistry.getModelProfile("remote")?.source).toBe("registry");
			expect(
				modelRegistry.getAll().find(model => model.provider === "provider" && model.id === "remote-model"),
			).toBe(undefined);
			expect(
				modelRegistry
					.getAll()
					.find(model => model.provider === "alibaba-token-plan" && model.id === "MiniMax-M2.5"),
			).toMatchObject({ contextWindow: 12_345, baseUrl: expect.stringContaining("https://") });
			expect(
				modelRegistry
					.getAll()
					.find(model => model.provider === "alibaba-token-plan" && model.id === "registry-only-model"),
			).toMatchObject({ contextWindow: 24_680, baseUrl: expect.stringContaining("https://") });
		} finally {
			authStorage.close();
		}
		const merged = mergeModelProfiles(
			{ remote: { required_providers: ["user"], model_mapping: { default: "user/model" } } },
			accepted.profiles,
		);
		expect(merged.get("codex-medium")?.modelMapping.default).toBe("provider/remote-model");
		expect(merged.get("remote")?.modelMapping.default).toBe("user/model");
	});

	test("rejects invalid signature, digest, compatibility, snapshot binding, and unknown fields without replacing LKG", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1, [registryProfile("stable")]));
		const invalidSignature = signedRegistry(data.privateKey, 2);
		invalidSignature.manifest.signature.value = Buffer.alloc(64).toString("base64");
		invalidSignature.manifestBody = canonicalModelPresetRegistryJson(invalidSignature.manifest);
		await expect(accept(data, invalidSignature)).rejects.toThrow(/signature verification/i);
		const digestMismatch = signedRegistry(data.privateKey, 2);
		digestMismatch.profilesBody += " ";
		await expect(accept(data, digestMismatch)).rejects.toThrow(/size mismatch|digest mismatch/i);
		const incompatible = signedRegistry(data.privateKey, 2, undefined, undefined, {
			consumerContract: { minVersion: "2.0.0", maxVersion: "3.0.0" },
		});
		await expect(accept(data, incompatible)).rejects.toThrow(/incompatible/i);
		const mismatch = signedRegistry(data.privateKey, 2);
		mismatch.snapshot.contents.profiles.sha256 = "0".repeat(64);
		mismatch.snapshotBody = canonicalModelPresetRegistryJson(mismatch.snapshot);
		await expect(accept(data, mismatch)).rejects.toThrow(/digest mismatch|does not match/i);
		const unknown = signedRegistry(data.privateKey, 2);
		unknown.profilesBody = canonicalModelPresetRegistryJson({ ...unknown.profiles, apiKey: "DO-NOT-ACCEPT" });
		await expect(accept(data, unknown)).rejects.toThrow(/schema rejected|digest mismatch|size mismatch/i);
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys });
		expect(accepted.revision).toBe(1);
		expect(accepted.profiles.has("stable")).toBe(true);
	});

	test("rejects malicious roles, duplicate identities, noncanonical bytes, oversized streams, redirects, and timeout", async () => {
		const data = await fixture();
		const invalidRole = signedRegistry(data.privateKey, 1);
		invalidRole.profiles.profiles[0]!.roleBindings = { default: "provider/model", shell: "sh/curl" } as never;
		invalidRole.profilesBody = canonicalModelPresetRegistryJson(invalidRole.profiles);
		await expect(accept(data, invalidRole)).rejects.toThrow(/schema rejected|digest mismatch|size mismatch/i);
		const duplicates = signedRegistry(data.privateKey, 1, [registryProfile("same"), registryProfile("same")]);
		await expect(accept(data, duplicates)).rejects.toThrow(/duplicate|schema rejected/i);
		const reserved = signedRegistry(data.privateKey, 1, [registryProfile("system-shadow")]);
		await expect(accept(data, reserved)).rejects.toThrow(/reserved profile id namespace/i);
		const confusable = signedRegistry(data.privateKey, 1, undefined, [
			{ ...registryPreset("model"), provider: "scope" },
			{ ...registryPreset("mоdel"), provider: "scope" },
		]);
		await expect(accept(data, confusable)).rejects.toThrow(/confusable preset selector/i);
		const noncanonical = signedRegistry(data.privateKey, 1);
		noncanonical.manifestBody = JSON.stringify(noncanonical.manifest, null, 2);
		await expect(accept(data, noncanonical)).rejects.toThrow(/canonical/i);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				trustedKeys: data.trustedKeys,
				allowTestUrls: true,
				maxManifestBytes: 4,
				fetch: (async () => new Response("oversized")) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/byte limit/i);
		const redirectedResponse = new Response(noncanonical.manifestBody);
		Object.defineProperty(redirectedResponse, "url", { value: "https://evil.example/latest.json" });
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				trustedKeys: data.trustedKeys,
				allowTestUrls: true,
				fetch: (async () => redirectedResponse) as unknown as typeof fetch,
			}),
		).rejects.toThrow(/URL changed/i);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				trustedKeys: data.trustedKeys,
				allowTestUrls: true,
				timeoutMs: 5,
				fetch: ((_input, init) =>
					new Promise((_resolve, reject) =>
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
					)) as typeof fetch,
			}),
		).rejects.toThrow(/timed out/i);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				trustedKeys: data.trustedKeys,
				allowTestUrls: true,
				fetch: (async () => {
					throw new Error("token=SUPERSECRET https://private.example/path");
				}) as unknown as typeof fetch,
			}),
		).rejects.toThrow("Registry refresh failed.");
		expect(
			getModelPresetRegistryStatus({ agentDir: data.agentDir, trustedKeys: data.trustedKeys }).lastError,
		).not.toContain("SUPERSECRET");
	});

	test("rejects downgrade and same-revision equivocation", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 2));
		await expect(accept(data, signedRegistry(data.privateKey, 1))).rejects.toThrow(/downgrade/i);
		await expect(accept(data, signedRegistry(data.privateKey, 2, [registryProfile("changed")]))).rejects.toThrow(
			/equivocation/i,
		);
	});

	test("rejects every manifest signed by a revoked key, including pre-revocation publications", async () => {
		const data = await fixture();
		const key = data.trustedKeys.get("test-key")!;
		key.revokedAt = "2027-01-01T00:00:00.000Z";
		await expect(accept(data, signedRegistry(data.privateKey, 1))).rejects.toThrow(/revoked/i);
	});

	test("uses ETag 304 only with a verified warm cache", async () => {
		const data = await fixture();
		const registry = signedRegistry(data.privateKey, 1);
		await accept(data, registry);
		let ifNoneMatch: string | null = null;
		const fetch304 = (async (_input, init) => {
			ifNoneMatch = new Headers(init?.headers).get("if-none-match");
			return new Response(null, { status: 304 });
		}) as typeof fetch;
		expect(await accept(data, registry, fetch304)).toEqual({ status: "not_modified", revision: 1 });
		expect(ifNoneMatch as string | null).toBe('"revision"');
	});

	test("falls back cold, remains usable offline warm, and rejects cache corruption without secret leakage", async () => {
		const data = await fixture();
		expect(loadAcceptedModelPresetRegistry(data.agentDir).profiles.size).toBe(0);
		await accept(data, signedRegistry(data.privateKey, 1, [registryProfile("stable")]));
		expect(
			loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys }).profiles.has("stable"),
		).toBe(true);
		const statePath = path.join(data.agentDir, "model-presets", "state.json");
		const state = await Bun.file(statePath).json();
		state.history[0].retainedProfiles = [registryProfile("retained-unsafe", "https://evil.example/model")];
		await Bun.write(statePath, JSON.stringify(state));
		const unsafeRetained = loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys });
		expect(unsafeRetained.profiles.size).toBe(0);
		expect(unsafeRetained.error).toMatch(/unsafe URL/i);
		await fs.writeFile(path.join(data.agentDir, "model-presets", "state.json"), '{"secret":"DO-NOT-LOG"}');
		const corrupted = loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys });
		expect(corrupted.profiles.size).toBe(0);
		expect(corrupted.error).not.toContain("DO-NOT-LOG");
	});

	test("single-flights concurrent refresh and retains disappeared profiles and presets", async () => {
		const data = await fixture();
		await accept(
			data,
			signedRegistry(
				data.privateKey,
				1,
				[
					registryProfile("retained", "provider/retained-model"),
					registryProfile("retained-dynamic", "dynamic-provider/future-model"),
				],
				[registryPreset("retained-model")],
				undefined,
				["dynamic-provider"],
			),
		);
		const second = signedRegistry(
			data.privateKey,
			2,
			[registryProfile("replacement", "provider/replacement-model")],
			[registryPreset("replacement-model")],
		);
		let calls = 0;
		const responses = [second.manifestBody, second.snapshotBody, second.profilesBody, second.presetsBody];
		const fetchImpl = (async () => {
			const body = responses[calls++]!;
			await Bun.sleep(5);
			return new Response(body, calls === 1 ? { headers: { etag: '"two"' } } : undefined);
		}) as unknown as typeof fetch;
		await Promise.all([accept(data, second, fetchImpl), accept(data, second, fetchImpl)]);
		expect(calls).toBe(4);
		const accepted = loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys });
		expect(accepted.profiles.has("retained")).toBe(true);
		expect(accepted.profiles.has("retained-dynamic")).toBe(true);
		expect(accepted.presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "retained-model" })]));
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir, trustedKeys: data.trustedKeys }).cacheHealth).toBe(
			"valid",
		);
		const state = await Bun.file(path.join(data.agentDir, "model-presets", "state.json")).json();
		expect(state.history[0].retainedDynamicProviders).toEqual(["dynamic-provider"]);
	});

	test("never awaits startup network and publishes a later accepted catalog to the live registry", async () => {
		const data = await fixture();
		const remote = signedRegistry(data.privateKey, 1, [registryProfile("background-profile")]);
		let calls = 0;
		const fetchImpl = registryFetch(remote);
		const countingFetch = (async (input, init) => {
			calls++;
			if (calls > 4) return new Response(null, { status: 304 });
			return fetchImpl(input, init);
		}) as typeof fetch;
		const authStorage = await AuthStorage.create(path.join(data.agentDir, "background-auth.db"));
		let modelRegistry: ModelRegistry | undefined;
		try {
			modelRegistry = new ModelRegistry(authStorage, path.join(data.agentDir, "models.yml"), undefined, {
				trustedKeys: data.trustedKeys,
				allowTestUrls: true,
				manifestUrl,
				fetch: countingFetch,
				startupDelayMs: 20,
				refreshIntervalMs: 30,
			});
			expect(calls).toBe(0);
			expect(modelRegistry.getModelProfile("background-profile")).toBeUndefined();
			for (let attempt = 0; attempt < 50 && !modelRegistry.getModelProfile("background-profile"); attempt++)
				await Bun.sleep(10);
			expect(calls).toBe(4);
			expect(modelRegistry.getModelProfile("background-profile")?.source).toBe("registry");
			for (let attempt = 0; attempt < 20 && calls < 5; attempt++) await Bun.sleep(10);
			expect(calls).toBeGreaterThanOrEqual(5);
			modelRegistry.dispose();
			const callsAfterDispose = calls;
			await Bun.sleep(50);
			expect(calls).toBe(callsAfterDispose);
		} finally {
			modelRegistry?.dispose();
			authStorage.close();
		}
	});

	test("supports rollback, pin, unpin, and disable without lowering highest-seen provenance", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await accept(data, signedRegistry(data.privateKey, 2));
		await rollbackModelPresetRegistry({ agentDir: data.agentDir, trustedKeys: data.trustedKeys, revision: 1 });
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir, trustedKeys: data.trustedKeys })).toMatchObject({
			activeRevision: 1,
			highestSeenRevision: 2,
		});
		await accept(data, signedRegistry(data.privateKey, 2));
		expect(
			getModelPresetRegistryStatus({ agentDir: data.agentDir, trustedKeys: data.trustedKeys }).activeRevision,
		).toBe(1);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				trustedKeys: data.trustedKeys,
				allowTestUrls: true,
				fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
			}),
		).resolves.toMatchObject({ status: "not_modified", revision: 2 });
		expect(
			getModelPresetRegistryStatus({ agentDir: data.agentDir, trustedKeys: data.trustedKeys }).activeRevision,
		).toBe(1);
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 2 });
		expect(loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys }).revision).toBe(2);
		await setModelPresetRegistryPin({ agentDir: data.agentDir });
		await setModelPresetRegistryDisabled({ agentDir: data.agentDir, disabled: true });
		expect(loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys })).toMatchObject({
			disabled: true,
		});
		await setModelPresetRegistryDisabled({ agentDir: data.agentDir, disabled: false });
		expect(
			getModelPresetRegistryStatus({ agentDir: data.agentDir, trustedKeys: data.trustedKeys }).highestSeenRevision,
		).toBe(2);
	});

	test("never evicts a selected pinned generation when bounded history advances", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		await setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
		for (let revision = 2; revision <= 5; revision++) await accept(data, signedRegistry(data.privateKey, revision));
		expect(loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys }).revision).toBe(1);
		expect(
			getModelPresetRegistryStatus({ agentDir: data.agentDir, trustedKeys: data.trustedKeys }).historyRevisions,
		).toEqual([5, 4, 3, 2, 1]);
	});

	test("serializes a concurrent pin against refresh history pruning", async () => {
		const data = await fixture();
		for (let revision = 1; revision <= 4; revision++) await accept(data, signedRegistry(data.privateKey, revision));
		const fifth = signedRegistry(data.privateKey, 5);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const responses = [fifth.manifestBody, fifth.snapshotBody, fifth.profilesBody, fifth.presetsBody];
		const fetchImpl = (async () => {
			if (calls === 0) {
				entered.resolve();
				await release.promise;
			}
			return new Response(responses[calls++]!);
		}) as unknown as typeof fetch;
		const refresh = refreshModelPresetRegistry({
			agentDir: data.agentDir,
			manifestUrl,
			trustedKeys: data.trustedKeys,
			fetch: fetchImpl,
			allowTestUrls: true,
		});
		await entered.promise;
		const pin = setModelPresetRegistryPin({ agentDir: data.agentDir, revision: 1 });
		await Bun.sleep(20);
		release.resolve();
		await expect(refresh).resolves.toMatchObject({ status: "updated", revision: 5 });
		await expect(pin).rejects.toThrow(/Cannot pin unaccepted registry revision 1/);
		expect(getModelPresetRegistryStatus({ agentDir: data.agentDir, trustedKeys: data.trustedKeys })).toMatchObject({
			cacheHealth: "valid",
			activeRevision: 5,
		});
	});

	test("rejects an oversized next state without replacing the active LKG", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1));
		const second = signedRegistry(data.privateKey, 2);
		await expect(
			refreshModelPresetRegistry({
				agentDir: data.agentDir,
				manifestUrl,
				trustedKeys: data.trustedKeys,
				fetch: registryFetch(second),
				allowTestUrls: true,
				maxStateBytes: 100,
			}),
		).rejects.toThrow(/durable size limit/i);
		expect(loadAcceptedModelPresetRegistry(data.agentDir, { trustedKeys: data.trustedKeys }).revision).toBe(1);
	});

	test("uses the same accepted profile catalog in coordinator and broker preflight", async () => {
		const data = await fixture();
		await accept(data, signedRegistry(data.privateKey, 1, [registryProfile("surface-profile")]));
		const originalAgentDir = getAgentDir();
		const productionTrust = MODEL_PRESET_REGISTRY_TRUSTED_KEYS as Map<string, ModelPresetRegistryTrustedKey>;
		const testKey = data.trustedKeys.get("test-key")!;
		productionTrust.set(testKey.keyId, testKey);
		setAgentDir(data.agentDir);
		try {
			expect((await loadCoordinatorModelProfiles()).has("surface-profile")).toBe(true);
			expect(validateBrokerModelPresetForTest(data.agentDir, "surface-profile")).toBe("surface-profile");
		} finally {
			setAgentDir(originalAgentDir);
			productionTrust.delete(testKey.keyId);
		}
	});
});
