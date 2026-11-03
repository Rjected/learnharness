/**
 * Gemini's MALFORMED_FUNCTION_CALL salvage.
 *
 * Gemini sometimes garbles one function call mid-generation — most often
 * when a step emits several calls with long non-English arguments (seen
 * live: text + anki_propose_cards + ask_user_question, then the stop). The
 * provider turns that stop into an error, discarding a step whose text and
 * complete calls had already arrived intact: Google delivers each function
 * call whole, so every toolCall in the partial message is fully formed;
 * only the garbled one is missing.
 *
 * This wrapper keeps the intact work: an error whose raw stop reason is
 * MALFORMED_FUNCTION_CALL becomes a normal finish — "toolUse" when complete
 * calls exist (the loop runs them and the model continues), "stop" when only
 * text arrived. With nothing salvageable the error passes through as before.
 */

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export const SALVAGEABLE_STOPS = new Set(["MALFORMED_FUNCTION_CALL"]);

/** The finished message to use instead of the error, or null to keep the error. */
export function salvageMessage(error: AssistantMessage): AssistantMessage | null {
	if (!error.rawStopReason || !SALVAGEABLE_STOPS.has(error.rawStopReason)) return null;
	const hasCalls = error.content.some((c) => c.type === "toolCall");
	const hasText = error.content.some((c) => c.type === "text" && c.text.trim() !== "");
	if (!hasCalls && !hasText) return null;
	const { errorMessage: _dropped, ...rest } = error;
	return { ...rest, stopReason: hasCalls ? "toolUse" : "stop" };
}

export function salvageMalformedCalls(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of inner) {
				const saved = event.type === "error" ? salvageMessage(event.error) : null;
				if (saved) {
					console.warn(`[salvage] Gemini ${event.type === "error" ? event.error.rawStopReason : ""}: kept ${saved.content.length} block(s), finishing as ${saved.stopReason}`);
					out.push({ type: "done", reason: saved.stopReason as "toolUse" | "stop", message: saved });
				} else out.push(event);
			}
		} finally {
			out.end();
		}
	})();
	return out;
}
