/**
 * Text-to-speech: Gemini TTS with the Google key the model slots use
 * (SPEECH_KEY_ID). Every clip is cached on disk (data/tts/<hash>.wav), so a
 * sentence is only ever generated once, and the learner's own Anki recording
 * of the exact text wins over a generation.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { keyValue } from "./keys.ts";
import { profileForSpeech, SPEECH_KEY_ID, SPEECH_KEYLESS } from "../core/languages.ts";
import { ankiAudioFor, ankiMediaResponse } from "./anki.ts";
import { studyProfile } from "./language.ts";
import { bytesResponse } from "./media-response.ts";
import { geminiUsageTokens } from "../core/audio-usage.ts";
import { appendAudioUsage } from "../store/audio-usage.ts";

export const TTS_MODEL = "gemini-3.8-flash-tts";
export const TTS_VOICE = "Sulafat";
export const TTS_MAX_CHARS = 600;

const TTS_DIR = path.join(PATHS.data, "tts");

const DEFAULT_STYLE = {
	normal: "Speak naturally and clearly, at a normal conversational pace.",
	slow: "Speak slowly and clearly, like a teacher reading to a beginner.",
};

export interface TtsRequest {
	text: string;
	/** BCP-47-ish language tag; Anki's "zh_CN" style is accepted. */
	lang: string;
	slow: boolean;
}

/** The language code sent to Gemini — zh-CN for all Mandarin. */
export function geminiLanguageCode(lang: string): string {
	const tag = lang.replace("_", "-");
	return /^(zh|cmn)(-CN|-Hans)?$/i.test(tag) ? "zh-CN" : tag;
}

export function ttsCachePath(req: TtsRequest): string {
	const hash = crypto
		.createHash("sha256")
		.update([TTS_MODEL, TTS_VOICE, geminiLanguageCode(req.lang), req.slow ? "slow" : "normal", req.text].join("\u0000"))
		.digest("hex")
		.slice(0, 32);
	return path.join(TTS_DIR, `${hash}.wav`);
}

export class TtsUnavailableError extends Error {}

/** A lesson id from the client, or null (only chat ids are accepted). */
export function chatParam(value: string | null | undefined): string | null {
	return value && /^chat_[\w-]+$/.test(value) ? value : null;
}

/** The clip's WAV bytes — from cache, or generated (and cached) now. A generation is
 *  recorded in the audio usage ledger against `chatId` (cache hits cost nothing). */
export async function ttsAudio(req: TtsRequest, chatId: string | null = null): Promise<Uint8Array<ArrayBuffer>> {
	const file = ttsCachePath(req);
	if (fs.existsSync(file)) return fs.readFileSync(file);
	const key = keyValue(SPEECH_KEY_ID);
	if (!key) throw new TtsUnavailableError(SPEECH_KEYLESS);
	const style = profileForSpeech(req.lang)?.ttsStyle ?? DEFAULT_STYLE;

	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`, {
		method: "POST",
		headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: req.text, speechMetadata: { style: req.slow ? style.slow : style.normal } }] }],
			generationConfig: {
				responseModalities: ["AUDIO"],
				speechConfig: { voiceConfig: { voice: TTS_VOICE }, languageCode: geminiLanguageCode(req.lang) },
			},
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new TtsUnavailableError(`Gemini TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as {
		candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[];
		usageMetadata?: unknown;
		modelVersion?: string;
	};
	appendAudioUsage({
		at: new Date().toISOString(),
		kind: "tts",
		chatId,
		model: data.modelVersion ?? TTS_MODEL,
		...geminiUsageTokens(data.usageMetadata),
	});
	const inline = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
	if (!inline) throw new TtsUnavailableError("Gemini TTS returned no audio");
	const bytes = Buffer.from(inline.data, "base64");
	fs.mkdirSync(TTS_DIR, { recursive: true });
	fs.writeFileSync(file, bytes);
	return bytes;
}

/** GET /api/tts — the clip, or 503 so the browser falls back to its own voice. */
export async function ttsResponse(params: URLSearchParams, range: string | null): Promise<Response> {
	const text = (params.get("text") ?? "").trim();
	if (!text || text.length > TTS_MAX_CHARS) {
		return Response.json({ error: `text must be 1–${TTS_MAX_CHARS} characters` }, { status: 400 });
	}
	try {
		const req = { text, lang: params.get("lang") ?? studyProfile()?.speech ?? "zh-CN", slow: params.get("slow") === "1" };
		// The learner's own Anki recording of this exact word/sentence beats a fresh generation.
		const fromAnki = await ankiAudioFor(req.text, req.slow);
		if (fromAnki) return ankiMediaResponse(fromAnki, range);
		const bytes = await ttsAudio(req, chatParam(params.get("chat")));
		return bytesResponse(bytes, "audio/wav", range);
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 });
	}
}
