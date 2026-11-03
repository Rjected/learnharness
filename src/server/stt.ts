/**
 * Mixed English + studied-language dictation. The browser records a clip
 * (16 kHz mono WAV) and posts it here; Gemini transcribes it, writing the
 * target language in its own script. Uses the Google key (SPEECH_KEY_ID) and
 * the cheap model slot when it is a Google model.
 */

import { SPEECH_KEY_ID, SPEECH_KEYLESS, type LanguageProfile } from "../core/languages.ts";
import { keyValue } from "./keys.ts";
import { studyProfile } from "./language.ts";
import { effectiveSettings } from "./stores.ts";
import { chatParam } from "./tts.ts";
import { geminiUsageTokens } from "../core/audio-usage.ts";
import { appendAudioUsage } from "../store/audio-usage.ts";

export const STT_MAX_BYTES = 20 * 1024 * 1024;
const FALLBACK_MODEL = "gemini-flash-latest";

function prompt(profile: LanguageProfile | null): string {
	return [
		"Transcribe this audio exactly as spoken.",
		profile
			? `The speaker is an English speaker learning ${profile.label} and mixes the two languages. Write English words in English and ${profile.transcribeAs}, keeping the speaker's own words, mistakes included.`
			: "Keep the speaker's own words, mistakes included.",
		"Output only the transcript, with normal punctuation. If there is no speech, output nothing.",
	].join(" ");
}

function sttModel(): string {
	const cheap = effectiveSettings().models.cheap;
	return cheap?.provider === "google" ? cheap.id : FALLBACK_MODEL;
}

export async function transcribeAudio(wav: Uint8Array, mimeType = "audio/wav", chatId: string | null = null): Promise<string> {
	const key = keyValue(SPEECH_KEY_ID);
	if (!key) throw new Error(SPEECH_KEYLESS);
	const model = sttModel();
	const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
		method: "POST",
		headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ inlineData: { mimeType, data: Buffer.from(wav).toString("base64") } }, { text: prompt(studyProfile()) }] }],
			generationConfig: { temperature: 0 },
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`Gemini transcription ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as {
		candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
		usageMetadata?: unknown;
		modelVersion?: string;
	};
	appendAudioUsage({
		at: new Date().toISOString(),
		kind: "stt",
		chatId,
		model: data.modelVersion ?? model,
		...geminiUsageTokens(data.usageMetadata),
	});
	const parts = data.candidates?.[0]?.content?.parts ?? [];
	return parts
		.filter((p) => !p.thought && p.text)
		.map((p) => p.text)
		.join("")
		.trim();
}

/** POST /api/stt/transcribe — body is the recorded clip. */
export async function transcribeResponse(request: Request): Promise<Response> {
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.length === 0 || bytes.length > STT_MAX_BYTES) {
		return Response.json({ error: "Recording is empty or too long" }, { status: 400 });
	}
	try {
		const chatId = chatParam(new URL(request.url).searchParams.get("chat"));
		const text = await transcribeAudio(bytes, request.headers.get("content-type") ?? "audio/wav", chatId);
		return Response.json({ text });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
	}
}
