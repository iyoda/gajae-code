import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelPresetRegistryTrustedKey } from "../model-preset-registry";

interface ModelPresetRegistryTestTrustContext {
	agentDir: string;
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>;
}

const testTrustContext = new AsyncLocalStorage<ModelPresetRegistryTestTrustContext>();

export function getModelPresetRegistryTestTrustedKeys(
	agentDir: string,
): ReadonlyMap<string, ModelPresetRegistryTrustedKey> | undefined {
	const context = testTrustContext.getStore();
	return context?.agentDir === agentDir ? context.trustedKeys : undefined;
}

export function runWithModelPresetRegistryTestTrust<T>(
	agentDir: string,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
	operation: () => T,
): T {
	return testTrustContext.run({ agentDir, trustedKeys }, operation);
}
