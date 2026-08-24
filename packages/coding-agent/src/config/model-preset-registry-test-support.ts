import type { ModelPresetRegistryTrustedKey } from "./model-preset-registry";
import { runWithModelPresetRegistryTestTrust } from "./model-preset-registry-test-state";

/** Runs one test operation with scoped trust. This module is denied by package exports. */
export function withModelPresetRegistryTestTrust<T>(
	agentDir: string,
	trustedKeys: ReadonlyMap<string, ModelPresetRegistryTrustedKey>,
	operation: () => T,
): T {
	return runWithModelPresetRegistryTestTrust(agentDir, trustedKeys, operation);
}
