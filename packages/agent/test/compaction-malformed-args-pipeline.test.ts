/**
 * Red-team integration: the full compaction pipeline must survive a persisted
 * session whose summarization window contains a tool call with non-object
 * `arguments` (null/undefined/number/string), and must still produce the
 * serialized conversation that feeds the summarization model.
 *
 * This goes beyond the unit fixture (packages/agent/test/compaction-null-tool-arguments.test.ts)
 * by driving the real `prepareCompaction` → `serializeConversation` → `compact`
 * path over a large persisted-history entry list, matching the production
 * failure mode ("Context overflow recovery failed: Object.entries requires
 * that input parameter not be null or undefined") observed on gjc/0.15.0 with
 * 2385-message sessions.
 */
import { describe, expect, it } from "bun:test";
import type { CompactionPreparation } from "@gajae-code/agent-core/compaction/compaction";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@gajae-code/agent-core/compaction/compaction";
import type { SessionEntry } from "@gajae-code/agent-core/compaction/entries";
import { convertToLlm } from "@gajae-code/agent-core/compaction/messages";
import { serializeConversation } from "@gajae-code/agent-core/compaction/utils";
import type { Message } from "@gajae-code/ai/types";

/** Narrow AgentMessage[] to the LLM Message[] shape serializeConversation accepts. */
function llmMessages(messages: CompactionPreparation["messagesToSummarize"]): Message[] {
	return convertToLlm(messages);
}

const MODEL = {
	id: "claude-opus-4-6",
	provider: "anthropic",
	api: "anthropic-messages",
	contextWindow: 1_000_000,
	maxTokens: 64_000,
} as const;

interface PersistedHistoryOptions {
	turns?: number;
	malformedTurn?: number;
	malformedArgs?: unknown;
}

/** Persisted session entries with a null/non-object-arguments tool call at `malformedTurn`. */
function persistedHistory(options: PersistedHistoryOptions = {}): SessionEntry[] {
	const turns = options.turns ?? 400;
	const malformedTurn = options.malformedTurn ?? Math.floor(turns / 4);
	// `??` would coerce an explicit undefined payload to null; distinguish "unset" via hasOwn.
	const malformedArgs = Object.hasOwn(options, "malformedArgs") ? options.malformedArgs : null;
	const entries: SessionEntry[] = [];
	let counter = 0;
	for (let i = 0; i < turns; i++) {
		const timestamp = new Date().toISOString();
		entries.push({
			type: "message",
			id: `e${counter++}`,
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${"context ".repeat(40)}` }],
				timestamp: Date.now(),
			},
		} as SessionEntry);
		const args = i === malformedTurn ? malformedArgs : { command: `echo ${i}` };
		entries.push({
			type: "message",
			id: `e${counter++}`,
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: `c${i}`, name: "bash", arguments: args },
					{ type: "text", text: `assistant ${i}` },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: MODEL.id,
				usage: {
					input: Math.round(900_000 / turns),
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: Math.round(900_000 / turns) + 500,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as SessionEntry);
		entries.push({
			type: "message",
			id: `e${counter++}`,
			parentId: null,
			timestamp,
			message: {
				role: "toolResult",
				content: [{ type: "text", text: `result ${i} ${"x".repeat(400)}` }],
				toolCallId: `c${i}`,
				timestamp: Date.now(),
			},
		} as SessionEntry);
	}
	return entries;
}

describe("compaction pipeline - persisted malformed tool-call arguments", () => {
	it.each([
		{ label: "null", args: null },
		{ label: "undefined", args: undefined },
		{ label: "number", args: 42 },
		{ label: "string", args: "oops" },
	])("serializes the real summarization window when arguments is $label", ({ args }) => {
		const entries = persistedHistory({ malformedArgs: args });
		const preparation = prepareCompaction(
			entries,
			{ ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
			{
				contextWindow: MODEL.contextWindow,
			},
		);
		expect(preparation).toBeDefined();

		const isMalformed = (value: unknown): boolean => {
			if (args === null) return value === null;
			if (args === undefined) return value === undefined;
			return value === args;
		};
		const malformed = preparation!.messagesToSummarize.filter(m => {
			if (m.role !== "assistant") return false;
			return m.content.some(b => b.type === "toolCall" && isMalformed(b.arguments));
		});
		expect(malformed.length).toBe(1);

		// The exact production crash site: this must not throw.
		const text = serializeConversation(llmMessages(preparation!.messagesToSummarize));
		expect(text.length).toBeGreaterThan(0);
		expect(text).toContain("bash()");
		expect(text).toContain('bash(command="echo 0")');
	});

	it("keeps the malformed call from blocking the rest of the window", () => {
		const entries = persistedHistory({ malformedTurn: 100 });
		const preparation = prepareCompaction(
			entries,
			{ ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
			{
				contextWindow: MODEL.contextWindow,
			},
		)!;
		const text = serializeConversation(llmMessages(preparation.messagesToSummarize));
		// Well-formed calls on both sides of the malformed one still serialize.
		expect(text).toContain('bash(command="echo 99")');
		expect(text).toContain("bash()");
		expect(text).toContain('bash(command="echo 101")');
	});

	it("reaches the summarization model call instead of dying in serialization", async () => {
		const entries = persistedHistory();
		const preparation = prepareCompaction(
			entries,
			{ ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
			{
				contextWindow: MODEL.contextWindow,
			},
		)!;
		// With an invalid API key the model call fails, but it must fail as a
		// provider call — never as the Object.entries serialization regression.
		try {
			await compact(preparation, MODEL as never, "sk-invalid-test-key");
			// Offline environments may resolve via no-op transports; the invariant
			// under test is that serialization completed, which reaching here proves.
			expect(true).toBe(true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).not.toContain("Object.entries");
		}
	});
});
