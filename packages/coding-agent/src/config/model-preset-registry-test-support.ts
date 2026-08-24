import type { ModelPresetRegistryTrustedKey } from "./model-preset-registry";
import { setModelPresetRegistryTestTrustedKeys } from "./model-preset-registry-test-state";

/** Test-only trust installation. This module is denied by package exports. */
export function installModelPresetRegistryTestTrust(
	agentDir: string,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
): () => void {
	setModelPresetRegistryTestTrustedKeys(agentDir, trustedKeys);
	return () => setModelPresetRegistryTestTrustedKeys(agentDir, undefined);
}
