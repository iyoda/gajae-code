import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { MODEL_PRESETS_ACTIONS, type ModelPresetsAction, runModelPresetsCommand } from "../cli/model-presets-cli";

export default class ModelPresets extends Command {
	static description = "Manage the signed model preset registry";

	static args = {
		action: Args.string({ description: "Action", required: false, options: MODEL_PRESETS_ACTIONS }),
		revision: Args.string({ description: "Accepted revision for pin or rollback", required: false }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(ModelPresets);
		await runModelPresetsCommand({
			action: (args.action ?? "status") as ModelPresetsAction,
			revision: args.revision,
			json: flags.json,
		});
	}
}
