import { getAgentDir } from "@gajae-code/utils";
import {
	getModelPresetRegistryStatus,
	type ModelPresetRegistryStatus,
	refreshModelPresetRegistry,
	rollbackModelPresetRegistry,
	setModelPresetRegistryDisabled,
	setModelPresetRegistryPin,
} from "../config/model-preset-registry";

export const MODEL_PRESETS_ACTIONS = ["status", "refresh", "rollback", "pin", "unpin", "disable", "enable"] as const;
export type ModelPresetsAction = (typeof MODEL_PRESETS_ACTIONS)[number];

export interface ModelPresetsCommandArgs {
	action: ModelPresetsAction;
	revision?: string;
	json?: boolean;
	agentDir?: string;
}

function parseRevision(value: string | undefined, action: "rollback" | "pin"): number {
	if (!value || !/^\d+$/.test(value)) throw new Error(`${action} requires a positive accepted revision.`);
	const revision = Number(value);
	if (!Number.isSafeInteger(revision) || revision <= 0)
		throw new Error(`${action} requires a positive accepted revision.`);
	return revision;
}

function humanStatus(status: ModelPresetRegistryStatus): string {
	const lines = [
		`source: ${status.source}`,
		`cache: ${status.cacheHealth}`,
		`contract: ${status.contractVersion}`,
		`active revision: ${status.activeRevisionId ?? status.activeRevision ?? "none"}`,
		`highest seen revision: ${status.highestSeenRevision ?? "none"}`,
		`pinned revision: ${status.pinnedRevision ?? "none"}`,
		`disabled: ${status.disabled ? "yes" : "no"}`,
		`profiles: ${status.profileCount}`,
		`model presets: ${status.presetCount}`,
		`history: ${status.historyRevisions.length > 0 ? status.historyRevisions.join(", ") : "none"}`,
	];
	if (status.manifestSha256) lines.push(`manifest sha256: ${status.manifestSha256}`);
	if (status.snapshotSha256) lines.push(`snapshot sha256: ${status.snapshotSha256}`);
	if (status.profilesSha256) lines.push(`profiles sha256: ${status.profilesSha256}`);
	if (status.presetsSha256) lines.push(`presets sha256: ${status.presetsSha256}`);
	if (status.keyId) lines.push(`signature key: ${status.keyId}`);
	if (status.sourceRevision) lines.push(`source revision: ${status.sourceRevision}`);
	if (status.acceptedAt) lines.push(`accepted: ${status.acceptedAt}`);
	if (status.lastCheckedAt) lines.push(`last checked: ${status.lastCheckedAt}`);
	if (status.retainedProfiles.length > 0)
		lines.push(`retained removed profiles: ${status.retainedProfiles.join(", ")}`);
	if (status.retainedPresets.length > 0) lines.push(`retained removed presets: ${status.retainedPresets.join(", ")}`);
	if (status.lastError) lines.push(`last error: ${status.lastError}`);
	return `${lines.join("\n")}\n`;
}

function writeStatus(status: ModelPresetRegistryStatus, json: boolean): void {
	process.stdout.write(json ? `${JSON.stringify(status)}\n` : humanStatus(status));
}

export async function runModelPresetsCommand(args: ModelPresetsCommandArgs): Promise<void> {
	const agentDir = args.agentDir ?? getAgentDir();
	const dependencies = { agentDir };
	switch (args.action) {
		case "status":
			writeStatus(getModelPresetRegistryStatus(dependencies), args.json === true);
			return;
		case "refresh": {
			const result = await refreshModelPresetRegistry(dependencies);
			if (args.json) {
				process.stdout.write(`${JSON.stringify({ result, status: getModelPresetRegistryStatus(dependencies) })}\n`);
			} else {
				process.stdout.write(
					result.status === "updated"
						? `Accepted preset registry revision ${result.revision}.\n`
						: result.status === "not_modified"
							? "Preset registry is already current.\n"
							: "Preset registry refresh is disabled.\n",
				);
			}
			return;
		}
		case "rollback":
			await rollbackModelPresetRegistry({ ...dependencies, revision: parseRevision(args.revision, "rollback") });
			break;
		case "pin":
			await setModelPresetRegistryPin({ ...dependencies, revision: parseRevision(args.revision, "pin") });
			break;
		case "unpin":
			await setModelPresetRegistryPin(dependencies);
			break;
		case "disable":
			await setModelPresetRegistryDisabled({ ...dependencies, disabled: true });
			break;
		case "enable":
			await setModelPresetRegistryDisabled({ ...dependencies, disabled: false });
			break;
	}
	writeStatus(getModelPresetRegistryStatus(dependencies), args.json === true);
}
