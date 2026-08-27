import { describe, expect, it } from "bun:test";
import {
	formatDeepInterviewSelectorPrompt,
	isDeepInterviewAskQuestion,
	renderDeepInterviewAskQuestion,
} from "@gajae-code/coding-agent/deep-interview/render-middleware";
import {
	isWorkflowPlaceholderText,
	WORKFLOW_PLACEHOLDER_CORRECTION,
} from "@gajae-code/coding-agent/gjc-runtime/workflow-placeholder";
import { askSchema, recoverRoundZeroIntentContract } from "@gajae-code/coding-agent/tools/ask-contract";

const PLACEHOLDERS = [
	"",
	"   \n\t",
	"unused",
	"TODO",
	"tbd",
	"n-a",
	"n/a",
	"N/A",
	"none",
	"placeholder",
	"empty",
	"stub",
];

function roundQuestion(question: string): Record<string, unknown> {
	return {
		questions: [
			{
				id: "q1",
				question,
				options: [{ label: "Continue" }],
				deepInterview: {
					round: 1,
					component: "scope",
					dimension: "constraints",
					ambiguity: 0.4,
				},
			},
		],
	};
}

describe("shared workflow placeholder semantics", () => {
	it("recognizes empty and exact placeholder bodies while preserving meaningful questions", () => {
		for (const value of PLACEHOLDERS) expect(isWorkflowPlaceholderText(value)).toBe(true);
		expect(isWorkflowPlaceholderText("Should exports preserve ordering?")).toBe(false);
		expect(isWorkflowPlaceholderText("TODO items are displayed in the review panel")).toBe(false);
	});

	it("rejects every placeholder through the named raw deep-interview contract", () => {
		for (const question of PLACEHOLDERS) {
			const result = recoverRoundZeroIntentContract(roundQuestion(question));
			expect(result).toMatchObject({
				outcome: "reject",
				code: "ask-deep-interview-question-body-required",
				detail: {
					rejectedKeys: ["questions[0].question"],
					hint: WORKFLOW_PLACEHOLDER_CORRECTION,
				},
			});
		}
	});

	it("rejects placeholders in the schema and accepts valid deep-interview questions", () => {
		for (const question of PLACEHOLDERS) expect(askSchema.safeParse(roundQuestion(question)).success).toBe(false);
		expect(askSchema.safeParse(roundQuestion("Which export behavior is required?")).success).toBe(true);
	});

	it("preserves ordinary null metadata and rejects encoded deep-interview containers", () => {
		const ordinary = roundQuestion("TODO");
		(ordinary.questions as Array<Record<string, unknown>>)[0].deepInterview = null;
		expect(recoverRoundZeroIntentContract(ordinary).outcome).toBe("passthrough");

		const encoded = JSON.stringify(roundQuestion("TODO"));
		expect(recoverRoundZeroIntentContract(encoded as unknown as Record<string, unknown>)).toMatchObject({
			outcome: "reject",
			code: "ask-deep-interview-question-body-required",
		});
	});
});

describe("deep-interview placeholder rendering", () => {
	it("does not render a placeholder round body or selector prompt", () => {
		const raw = "Round 2 | Targeting: scope | Why now: needed | Ambiguity: 40%\n\nTODO";
		expect(formatDeepInterviewSelectorPrompt(raw)).toBeNull();
		// @ts-expect-error test intentionally supplies an uninitialized theme
		expect(renderDeepInterviewAskQuestion(raw, undefined)).toBeNull();
	});

	it("rejects placeholder-only Round 0 topology bodies", () => {
		const raw = "Round 0 | Topology confirmation | Ambiguity: not scored yet\n\nTODO";
		expect(formatDeepInterviewSelectorPrompt(raw)).toBeNull();
		expect(renderDeepInterviewAskQuestion(raw, undefined as never)).toBeNull();
		expect(isDeepInterviewAskQuestion(raw)).toBe(false);
	});
});
