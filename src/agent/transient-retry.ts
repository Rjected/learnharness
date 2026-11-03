/**
 * Retry a model call that died on the wire before producing anything.
 *
 * pi-ai's provider retry is off by default and only covers HTTP errors, so a
 * dropped connection or undici's 300s headers/body timeout ("fetch failed",
 * seen live on a gemini-pro high-thinking step) ended the turn with an empty
 * assistant message and a stuck "Something went wrong". A step that failed
 * before its first content event has nothing to lose, so it is re-issued
 * from scratch. Once any content has streamed, errors pass through as before.
 *
 * Silence watchdog: thinking streams (Gemini sends thought parts as it goes;
 * the slowest healthy gemini-pro step on record took 36s end to end), so a
 * call that receives no event for GEMINI_STALL_MS is a dead connection, not a slow
 * answer. It is aborted rather than left to undici's 300s timeout, then
 * retried like any other empty network failure. Only Google gets one:
 * other providers can reason silently for minutes (stallMs 0 = off).
 */

import {
	createAssistantMessageEventStream,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

const TRANSIENT =
	/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|socket hang up|other side closed|terminated|UND_ERR|network|\b(500|502|503|504)\b|UNAVAILABLE|overloaded|INTERNAL|no response from the model/i;
const DELAYS_MS = [2_000, 8_000];
export const GEMINI_STALL_MS = 90_000;

export function isTransientError(message: string | undefined): boolean {
	return !!message && TRANSIENT.test(message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

export function retryTransientFailures(
	call: (signal: AbortSignal) => AssistantMessageEventStream,
	signal?: AbortSignal,
	delays = DELAYS_MS,
	stallMs = 0,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for (let attempt = 0; ; attempt++) {
				const watchdog = new AbortController();
				let stalled = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const arm = () => {
					clearTimeout(timer);
					if (stallMs > 0) timer = setTimeout(() => { stalled = true; watchdog.abort(); }, stallMs);
				};
				let start: AssistantMessageEvent | null = null;
				let streaming = false;
				let retry = false;
				arm();
				try {
					for await (const raw of call(signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal)) {
						arm();
						// The watchdog's abort surfaces as an "aborted" error; report it as
						// the stall it is, not as the learner pressing stop.
						const event: AssistantMessageEvent =
							stalled && raw.type === "error" && !signal?.aborted
								? { type: "error", reason: "error", error: { ...raw.error, stopReason: "error", errorMessage: `No response from the model for ${Math.round(stallMs / 1000)}s` } }
								: raw;
						if (streaming) { out.push(event); continue; }
						// Hold the start event until we know whether this attempt is kept,
						// so a retried step doesn't open two assistant messages downstream.
						if (event.type === "start") { start = event; continue; }
						const empty = event.type === "error" && event.error.content.length === 0;
						if (empty && attempt < delays.length && !signal?.aborted && isTransientError(event.error.errorMessage)) {
							console.warn(`[retry] model call failed before any output (${event.error.errorMessage}); retry ${attempt + 1}/${delays.length}`);
							retry = true;
							break;
						}
						streaming = true;
						if (start) out.push(start);
						out.push(event);
					}
				} finally {
					clearTimeout(timer);
				}
				if (!retry) break;
				await sleep(delays[attempt] ?? 0, signal);
			}
		} finally {
			out.end();
		}
	})();
	return out;
}
