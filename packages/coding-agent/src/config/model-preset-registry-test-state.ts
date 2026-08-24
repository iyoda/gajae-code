import type { ModelPresetRegistryTrustedKey } from "./model-preset-registry";

const trustedKeysByAgentDir = new Map<string, ReadonlyMap<string, ModelPresetRegistryTrustedKey>>();

export function getModelPresetRegistryTestTrustedKeys(
	agentDir: string,
): ReadonlyMap<string, ModelPresetRegistryTrustedKey> | undefined {
	return trustedKeysByAgentDir.get(agentDir);
}

export function setModelPresetRegistryTestTrustedKeys(
	agentDir: string,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey> | undefined,
): void {
	if (trustedKeys) trustedKeysByAgentDir.set(agentDir, trustedKeys);
	else trustedKeysByAgentDir.delete(agentDir);
}
