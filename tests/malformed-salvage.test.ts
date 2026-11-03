/** Gemini MALFORMED_FUNCTION_CALL salvage. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { salvageMalformedCalls, salvageMessage } from "../src/agent/malformed-salvage.ts";

function partial(content: AssistantMessage["content"], rawStopReason = "MALFORMED_FUNCTION_CALL"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-pro-latest",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		rawStopReason,
		errorMessage: `Provider stopped with: ${rawStopReason}`,
		timestamp: 0,
	} as AssistantMessage;
}

const text = { type: "text" as const, text: "Exactly. 个 in 一个人…" };
const call = { type: "toolCall" as const, id: "c1", name: "anki_propose_cards", arguments: { cards: [] } };

describe("salvageMessage", () => {
	it("keeps intact calls and finishes as toolUse", () => {
		const saved = salvageMessage(partial([text, call]));
		assert.equal(saved?.stopReason, "toolUse");
		assert.equal(saved?.errorMessage, undefined);
		assert.equal(saved?.content.length, 2);
	});

	it("text only finishes as stop", () => {
		assert.equal(salvageMessage(partial([text]))?.stopReason, "stop");
	});

	it("leaves other errors and empty steps alone", () => {
		assert.equal(salvageMessage(partial([text, call], "SAFETY")), null);
		assert.equal(salvageMessage(partial([{ type: "thinking", thinking: "hmm" } as never])), null);
	});
});

describe("salvageMalformedCalls", () => {
	it("turns the salvageable error into done and passes everything else through", async () => {
		const inner = createAssistantMessageEventStream();
		const msg = partial([text, call]);
		inner.push({ type: "start", partial: msg });
		inner.push({ type: "error", reason: "error", error: msg });
		inner.end();
		const events = [];
		const out = salvageMalformedCalls(inner);
		for await (const e of out) events.push(e.type);
		assert.deepEqual(events, ["start", "done"]);
		assert.equal((await out.result()).stopReason, "toolUse");
	});

	it("passes an unsalvageable error through", async () => {
		const inner = createAssistantMessageEventStream();
		const msg = partial([], "MALFORMED_FUNCTION_CALL");
		inner.push({ type: "error", reason: "error", error: msg });
		inner.end();
		const out = salvageMalformedCalls(inner);
		const events = [];
		for await (const e of out) events.push(e.type);
		assert.deepEqual(events, ["error"]);
		assert.equal((await out.result()).stopReason, "error");
	});
});
