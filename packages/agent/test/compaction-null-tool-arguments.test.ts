/**
 * Regression: compaction must survive a persisted tool call whose `arguments`
 * payload is null.
 *
 * `ToolCall.arguments` is typed `Record<string, any>`, but persisted session
 * history can carry `null` there (aborted / interrupted / malformed tool calls).
 * `serializeConversation` passed that value straight into `Object.entries`,
 * which throws:
 *
 *   TypeError: Object.entries requires that input parameter not be null or undefined
 *
 * That throw happens *inside* compaction, which is the recovery path for
 * context overflow. The session then surfaced
 * "Context overflow recovery failed: Object.entries requires ..." and the next
 * request went out uncompacted until the provider rejected it with
 * "prompt is too long".
 */
import { describe, expect, it } from "bun:test";
import type { Message } from "@gajae-code/ai";
import { serializeConversation } from "../src/compaction/utils";

function assistantWithToolCall(args: unknown): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: args as Record<string, unknown> }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as Message;
}

describe("serializeConversation - malformed tool-call arguments", () => {
	it.each([
		{ label: "null", args: null },
		{ label: "undefined", args: undefined },
	])("does not throw when arguments is $label", ({ args }) => {
		const serialized = serializeConversation([assistantWithToolCall(args)]);
		expect(serialized).toContain("bash()");
	});

	it("still serializes well-formed arguments", () => {
		const serialized = serializeConversation([assistantWithToolCall({ command: "ls" })]);
		expect(serialized).toContain('bash(command="ls")');
	});

	it("does not throw when a null-argument call is mixed into real history", () => {
		const serialized = serializeConversation([
			assistantWithToolCall({ command: "ls" }),
			assistantWithToolCall(null),
			assistantWithToolCall({ command: "pwd" }),
		]);
		expect(serialized).toContain('bash(command="ls")');
		expect(serialized).toContain("bash()");
		expect(serialized).toContain('bash(command="pwd")');
	});
});
