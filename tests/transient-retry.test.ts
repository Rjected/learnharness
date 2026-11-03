/** Re-issue a model step that died on the wire before any output. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { isTransientError, retryTransientFailures } from "../src/agent/transient-retry.ts";

function msg(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-pro-latest",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: 0,
	} as AssistantMessage;
}

const text = { type: "text" as const, text: "桌子上 — exactly." };

function stream(events: AssistantMessageEvent[]) {
	const s = createAssistantMessageEventStream();
	for (const e of events) s.push(e);
	s.end();
	return s;
}
const failed = (m = msg([], "error", "fetch failed")) => stream([{ type: "start", partial: m }, { type: "error", reason: "error", error: m }]);
const ok = () => { const m = msg([text], "stop"); return stream([{ type: "start", partial: m }, { type: "done", reason: "stop", message: m }]); };

/** A call that goes silent until aborted, the way pi-ai reports an abort. */
function hung(signal: AbortSignal, content: AssistantMessage["content"] = []) {
	const s = createAssistantMessageEventStream();
	const m = msg(content, "aborted", "Request was aborted");
	s.push({ type: "start", partial: m });
	if (content.length) s.push({ type: "text_start", contentIndex: 0, partial: m });
	signal.addEventListener("abort", () => { s.push({ type: "error", reason: "aborted", error: m }); s.end(); }, { once: true });
	return s;
}

async function drain(out: ReturnType<typeof retryTransientFailures>) {
	const types = [];
	for await (const e of out) types.push(e.type);
	return { types, result: await out.result() };
}

describe("retryTransientFailures", () => {
	it("re-issues an empty step that failed on the network", async () => {
		const attempts = [failed, ok];
		let calls = 0;
		const { types, result } = await drain(retryTransientFailures(() => attempts[calls++]!(), undefined, [0, 0]));
		assert.equal(calls, 2);
		assert.deepEqual(types, ["start", "done"]);
		assert.equal(result.stopReason, "stop");
	});

	it("gives up after the last delay and passes the error through", async () => {
		let calls = 0;
		const { types, result } = await drain(retryTransientFailures(() => (calls++, failed()), undefined, [0, 0]));
		assert.equal(calls, 3);
		assert.deepEqual(types, ["start", "error"]);
		assert.equal(result.errorMessage, "fetch failed");
	});

	it("never retries once content has streamed, or for non-transient errors", async () => {
		let calls = 0;
		const withText = msg([text], "error", "fetch failed");
		await drain(retryTransientFailures(() => (calls++, failed(withText)), undefined, [0]));
		assert.equal(calls, 1);
		calls = 0;
		await drain(retryTransientFailures(() => (calls++, failed(msg([], "error", "400 API key not valid"))), undefined, [0]));
		assert.equal(calls, 1);
	});

	it("aborts a silent call after the stall window and retries it", async () => {
		let calls = 0;
		const out = retryTransientFailures((signal) => (calls++ === 0 ? hung(signal) : ok()), undefined, [0], 30);
		const { types, result } = await drain(out);
		assert.equal(calls, 2);
		assert.deepEqual(types, ["start", "done"]);
		assert.equal(result.stopReason, "stop");
	});

	it("reports a stall after partial output as an error, without retrying", async () => {
		let calls = 0;
		const { types, result } = await drain(retryTransientFailures((signal) => (calls++, hung(signal, [text])), undefined, [0], 30));
		assert.equal(calls, 1);
		assert.deepEqual(types, ["start", "text_start", "error"]);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /No response from the model/);
	});

	it("leaves the learner's own stop as an abort", async () => {
		const stop = new AbortController();
		let calls = 0;
		const out = retryTransientFailures((signal) => (calls++, hung(signal)), stop.signal, [0], 10_000);
		setTimeout(() => stop.abort(), 10);
		const { result } = await drain(out);
		assert.equal(calls, 1);
		assert.equal(result.stopReason, "aborted");
	});

	it("classifies network failures as transient", () => {
		assert.ok(isTransientError("fetch failed"));
		assert.ok(isTransientError("503 UNAVAILABLE: The model is overloaded"));
		assert.ok(!isTransientError("400 INVALID_ARGUMENT"));
	});
});
