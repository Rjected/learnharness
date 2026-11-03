/**
 * The studied language on the server: its profile for the agent layer and
 * TTS/STT, and GET /api/language, which tells the client whether to draw
 * the speaker buttons and reading popups and whether speech is set up.
 */

import { LANGUAGES, SPEECH_KEY_ID, type LanguageProfile, type LanguageStatus } from "../core/languages.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The language being studied, or null when the layer is off (Settings → Agent → Studying). */
export function studyProfile(): LanguageProfile | null {
	const id = effectiveSettings().agent.language;
	return id ? LANGUAGES[id] : null;
}

export function languageStatus(): LanguageStatus {
	return { language: studyProfile()?.id ?? null, tts: !!keyValue(SPEECH_KEY_ID) };
}
