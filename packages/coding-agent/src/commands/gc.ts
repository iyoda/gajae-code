import { Command, Flags } from "@gajae-code/utils/cli";
import { isSettingsInitialized, settings } from "../config/settings";
import { type GcDiskPolicy, runGjcGcCommand } from "../gjc-runtime/gc-runtime";

/**
 * Resolve the `gc.*` retention knobs from settings. When settings are not
 * initialized (headless/early invocation) the runtime falls back to its
 * schema-backed defaults, so this returns nothing rather than guessing.
 */
function resolveDiskPolicyFromSettings(): Partial<GcDiskPolicy> | undefined {
	if (!isSettingsInitialized()) return undefined;
	return {
		sessions_max_age_days: settings.get("gc.sessions.maxAgeDays"),
		sessions_max_total_bytes: settings.get("gc.sessions.maxTotalBytes"),
		natives_keep_versions: settings.get("gc.natives.keepVersions"),
		backups_max_age_days: settings.get("gc.backups.maxAgeDays"),
	};
}

export default class Gc extends Command {
	static description = "Garbage-collect stale GJC session/PID records (dry-run by default)";
	static strict = false;
	// The hand parser in gc-runtime owns the real syntax (repeatable space-form
	// operands, dash-prefix rejection, orphan-operand rules); delegate help so the
	// public output is the authoritative gcHelpText() instead of generic flag
	// metadata that would advertise unsupported `--flag=<value>` forms.
	static delegateHelp = true;
	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		prune: Flags.boolean({ description: "Remove stale records (default: report only)", default: false }),
		force: Flags.boolean({ description: "Alias for --prune (eligible records only)", default: false }),
		"dry-run": Flags.boolean({ description: "Force report-only mode", default: false }),
		disk: Flags.boolean({
			description: "Also report on-disk retention (sessions, blobs, artifacts, natives, backups)",
			default: false,
		}),
		"repair-session-index": Flags.boolean({
			description: "Quarantine a corrupt session-index suffix and retain its valid prefix",
			default: false,
		}),
		"empty-delete-receipts": Flags.boolean({
			description: "Report (and with --prune, prune) empty .gjc-delete-* receipts under --root/--manifest",
			default: false,
		}),
		root: Flags.string({
			description: "Operand root for --empty-delete-receipts (repeatable)",
			multiple: true,
		}),
		manifest: Flags.string({
			description: 'JSON {"roots":[...]} file for --empty-delete-receipts (repeatable)',
			multiple: true,
		}),
	};

	static examples = [
		"gjc gc",
		"gjc gc --json",
		"gjc gc --prune",
		"gjc gc --prune --json",
		"gjc gc --disk",
		"gjc gc --disk --json",
		"gjc gc --disk --prune",
		"gjc gc --repair-session-index --json",
		"gjc gc --empty-delete-receipts --root ~/.gjc/agent/session-states",
		"gjc gc --empty-delete-receipts --manifest receipts-manifest.json --prune --json",
	];

	async run(): Promise<void> {
		const result = await runGjcGcCommand(
			this.argv,
			process.cwd(),
			process.env,
			undefined,
			resolveDiskPolicyFromSettings(),
		);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
