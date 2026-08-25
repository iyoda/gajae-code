import * as path from "node:path";
import type { AuthStorage } from "@gajae-code/ai/core";
import { ModelRegistry } from "../../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	type ResolveCliModelResult,
	resolveCliModel,
} from "../../config/model-resolver";
import { Settings } from "../../config/settings";
import { discoverAuthStorage } from "../session";

const MAX_ECHOED_MODEL_LENGTH = 256;

export interface SdkHostModelResolveContext {
	cwd?: string;
}

/** Registry loader owned by the SDK host, not by machine-facing adapters. */
export type SdkHostModelRegistryLoader = ((context?: SdkHostModelResolveContext) => ModelRegistry | Promise<ModelRegistry>) & {
	acquire?: (context?: SdkHostModelResolveContext) => () => void;
	dispose?: () => Promise<void>;
};

type OwnedModelRegistry = {
	registry: ModelRegistry;
	storage: AuthStorage;
};

const MAX_CACHED_MODEL_REGISTRIES = 32;

/**
 * Builds an offline model resolver for a single SDK host process.
 *
 * The registry is reused, but refreshed for every validation so additions and
 * removals made while the broker is alive are observed without network I/O.
 */
export function createSdkHostModelRegistryLoader(
	discoverStorage: () => Promise<AuthStorage>,
	modelsPath?: string,
	loadSettings?: (context?: SdkHostModelResolveContext) => Promise<Pick<Settings, "get" | "getGlobal">>,
): SdkHostModelRegistryLoader {
	const cachedRegistries = new Map<string, Promise<OwnedModelRegistry>>();
	const retiredRegistries = new Map<string, Promise<OwnedModelRegistry>[]>();
	const activeScopes = new Map<string, number>();
	const registryAgentDir = path.resolve(path.dirname(modelsPath ?? "."));
	let disposed = false;
	const scopeKeyFor = (context?: SdkHostModelResolveContext): string =>
		context?.cwd === undefined ? "" : path.resolve(context.cwd);
	const disposeEntry = async (entry: Promise<OwnedModelRegistry>): Promise<void> => {
		let owned: OwnedModelRegistry;
		try {
			owned = await entry;
		} catch {
			// Initialization failures close their storage before rejecting. Disposal is
			// best-effort and must not block broker shutdown on one broken scope.
			return;
		}
		try {
			owned.registry.dispose();
		} finally {
			owned.storage.close();
		}
	};
	const disposeEntries = (entries: Promise<OwnedModelRegistry>[]): void => {
		if (entries.length > 0) void Promise.all(entries.map(entry => disposeEntry(entry))).catch(() => undefined);
	};
	const retireEntry = (scopeKey: string, entry: Promise<OwnedModelRegistry>): void => {
		if ((activeScopes.get(scopeKey) ?? 0) > 0) {
			const retired = retiredRegistries.get(scopeKey) ?? [];
			retired.push(entry);
			retiredRegistries.set(scopeKey, retired);
			return;
		}
		disposeEntries([entry]);
	};
	const disposeRetired = (scopeKey: string): void => {
		const retired = retiredRegistries.get(scopeKey);
		if (!retired || (activeScopes.get(scopeKey) ?? 0) > 0) return;
		retiredRegistries.delete(scopeKey);
		disposeEntries(retired);
	};
	const evictIdleEntries = (): Promise<OwnedModelRegistry>[] => {
		const evicted: Promise<OwnedModelRegistry>[] = [];
		while (cachedRegistries.size > MAX_CACHED_MODEL_REGISTRIES) {
			const oldest = [...cachedRegistries.keys()].find(
				key => (activeScopes.get(key) ?? 0) === 0,
			);
			if (oldest === undefined) break;
			const entry = cachedRegistries.get(oldest);
			cachedRegistries.delete(oldest);
			if (entry) evicted.push(entry);
		}
		return evicted;
	};
	const loadRegistry = async (context?: SdkHostModelResolveContext): Promise<ModelRegistry> => {
		if (disposed) throw new Error("SDK host model registry loader is disposed.");
		const scopeKey = scopeKeyFor(context);
		let cachedRegistry = cachedRegistries.get(scopeKey);
		if (cachedRegistry === undefined) {
			const initializing = discoverStorage().then(async storage => {
				try {
					const registrySettings = await loadSettings?.(context);
					return {
						storage,
						registry: new ModelRegistry(storage, modelsPath, registrySettings, {
							agentDir: registryAgentDir,
							automaticRefresh: false,
						}),
					};
				} catch (error) {
					storage.close();
					throw error;
				}
			});
			cachedRegistries.set(scopeKey, initializing);
			cachedRegistry = initializing;
			disposeEntries(evictIdleEntries());
			try {
				await initializing;
			} catch (error) {
				if (cachedRegistries.get(scopeKey) === initializing) cachedRegistries.delete(scopeKey);
				throw error;
			}
		}
		const owned = await cachedRegistry;
		if (disposed) {
			retireEntry(scopeKey, cachedRegistry);
			throw new Error("SDK host model registry loader is disposed.");
		}
		cachedRegistries.delete(scopeKey);
		cachedRegistries.set(scopeKey, cachedRegistry);
		const registry = owned.registry;
		if (loadSettings) registry.setScopedSettings(await loadSettings(context));
		await registry.refresh("offline");
		return registry;
	};
	return Object.assign(loadRegistry, {
		dispose: async (): Promise<void> => {
			disposed = true;
			for (const [scopeKey, entry] of cachedRegistries) retireEntry(scopeKey, entry);
			cachedRegistries.clear();
			for (const scopeKey of retiredRegistries.keys()) disposeRetired(scopeKey);
		},
		acquire: (context?: SdkHostModelResolveContext): (() => void) => {
			const scopeKey = scopeKeyFor(context);
			activeScopes.set(scopeKey, (activeScopes.get(scopeKey) ?? 0) + 1);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const next = (activeScopes.get(scopeKey) ?? 1) - 1;
				if (next <= 0) activeScopes.delete(scopeKey);
				else activeScopes.set(scopeKey, next);
				disposeRetired(scopeKey);
				disposeEntries(evictIdleEntries());
			};
		},
	});
}

export type SdkHostModelResolution =
	| { ok: true; model: string | null }
	| { ok: false; reason: "unknown_model"; model: string; error: string };

export type SdkHostModelResolver = ((raw: unknown, context?: SdkHostModelResolveContext) => Promise<SdkHostModelResolution>) & {
	dispose?: () => Promise<void>;
};

/** Resolve the explicit model pin at the SDK host boundary. */
export async function resolveSdkHostModel(
	raw: unknown,
	loadRegistry: SdkHostModelRegistryLoader,
	context?: SdkHostModelResolveContext,
): Promise<SdkHostModelResolution> {
	if (raw === undefined || raw === null) return { ok: true, model: null };
	const requested = typeof raw === "string" ? raw : "";
	const echoed = requested.trim().slice(0, MAX_ECHOED_MODEL_LENGTH);
	const release = loadRegistry.acquire?.(context) ?? (() => {});
	try {
		const registry = await loadRegistry(context);
		const resolved: ResolveCliModelResult = resolveCliModel({ cliModel: requested, modelRegistry: registry });
		if (!resolved.model)
			return {
				ok: false,
				reason: "unknown_model",
				model: echoed,
				error: resolved.error ?? "No models available. Check your installation or add models to models.json.",
			};
		return {
			ok: true,
			model: formatModelSelectorValue(formatModelString(resolved.model), resolved.thinkingLevel),
		};
	} finally {
		release();
	}
}

/** Default resolver used by the SDK broker host. */
export function createDefaultSdkHostModelResolver(agentDir: string): SdkHostModelResolver {
	const loadRegistry = createSdkHostModelRegistryLoader(
		() => discoverAuthStorage(agentDir),
		path.join(agentDir, "models.yml"),
		context => Settings.loadReadonly({ agentDir, cwd: context?.cwd }),
	);
	return Object.assign(
		(raw: unknown, context?: SdkHostModelResolveContext): Promise<SdkHostModelResolution> =>
			resolveSdkHostModel(raw, loadRegistry, context),
		{ dispose: loadRegistry.dispose },
	);
}
