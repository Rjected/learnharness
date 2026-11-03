/**
 * The language being studied — pure, browser-safe.
 *
 * Settings → Agent → Studying picks one (agent.language; absent = Chinese,
 * "none" = plain LearnHarness). The choice switches on the whole layer:
 * the tutor's language fragment (prompts/languages/<id>/), the Anki tools
 * and Review page, a speaker button and a reading popup on every run of
 * the language, and mixed English + target-language dictation. Everything
 * that differs between languages lives in its profile below.
 */

export const STUDY_LANGUAGES = ["zh", "ja"] as const;
export type StudyLanguage = (typeof STUDY_LANGUAGES)[number];
/** The stored choice: a language, or "none" for no language layer. */
export type StudyChoice = StudyLanguage | "none";

export interface LanguageProfile {
	id: StudyLanguage;
	/** Settings label. */
	label: string;
	/** The language's own name (中文), for compact UI labels. */
	nativeName: string;
	/** BCP-47 tag for speech (Gemini TTS, the browser voice) and the html lang attribute. */
	speech: string;
	/** Gemini TTS delivery instructions. */
	ttsStyle: { normal: string; slow: string };
	/** The dictation chip for mixed English + this language. */
	dictationChip: string;
	/** How the transcriber writes the language. */
	transcribeAs: string;
	/** The proposal tool's field descriptions (anki_propose_cards). */
	cardText: string;
	cardReading: string;
}

export const LANGUAGES: Record<StudyLanguage, LanguageProfile> = {
	zh: {
		id: "zh",
		label: "Chinese",
		nativeName: "中文",
		speech: "zh-CN",
		ttsStyle: {
			normal: "Speak natural, standard Mandarin at a normal conversational pace, like a native speaker, clearly.",
			slow: "Speak slowly and clearly in standard Mandarin, like a teacher reading to a beginner. Keep tones accurate but natural.",
		},
		dictationChip: "中英",
		transcribeAs: "Mandarin in simplified Chinese characters (never pinyin)",
		cardText: "Simplified characters — a natural, complete sentence or phrase.",
		cardReading: "Tone-marked pinyin (nǐ hǎo), with tone sandhi as spoken.",
	},
	ja: {
		id: "ja",
		label: "Japanese",
		nativeName: "日本語",
		speech: "ja-JP",
		ttsStyle: {
			normal: "Speak natural, standard Japanese at a normal conversational pace, like a native speaker, clearly.",
			slow: "Speak slowly and clearly in standard Japanese, like a teacher reading to a beginner. Keep the pitch accent natural.",
		},
		dictationChip: "日英",
		transcribeAs: "Japanese as it is normally written, in kanji and kana (never romaji)",
		cardText: "Japanese as normally written (kanji and kana) — a natural, complete sentence or phrase.",
		cardReading: "The whole reading in hiragana (たべる).",
	},
};

export function isStudyLanguage(value: unknown): value is StudyLanguage {
	return (STUDY_LANGUAGES as readonly unknown[]).includes(value);
}

export function isStudyChoice(value: unknown): value is StudyChoice {
	return value === "none" || isStudyLanguage(value);
}

/** The language in effect for an agent settings section: absent = Chinese, "none" = off. */
export function studyLanguageOf(agent: { language?: StudyChoice } | undefined): StudyLanguage | null {
	const choice = agent?.language;
	return choice === "none" ? null : isStudyLanguage(choice) ? choice : "zh";
}

/** The key that turns speech on (Gemini TTS + mixed dictation); the same key Gemini models use. */
export const SPEECH_KEY_ID = "GEMINI_API_KEY";
/** The error speech surfaces carry without that key; the client turns it into a link to the setup. */
export const SPEECH_KEYLESS = "No Google key saved — add one in Settings → Keys → Audio.";

/** The profile whose speech tag matches an Anki/BCP-47 language tag (zh_CN, ja-JP…), if any. */
export function profileForSpeech(lang: string): LanguageProfile | undefined {
	const base = lang.replace("_", "-").split("-")[0]!.toLowerCase();
	return Object.values(LANGUAGES).find((p) => p.speech.split("-")[0] === (base === "cmn" ? "zh" : base));
}

/** What GET /api/language tells the client. */
export interface LanguageStatus {
	language: StudyLanguage | null;
	/** A Google (Gemini) key is saved, so speech can be generated. */
	tts: boolean;
}

// ─── The reading popup (GET /api/language/gloss) ───────────────────────────

export interface GlossEntry {
	/** The dictionary reading (pinyin / kana), plus the base form when the word was inflected. */
	reading: string;
	defs: string[];
}
export interface GlossWord {
	text: string;
	/** Reading in context; empty for punctuation and other non-target text. */
	reading: string;
	entries: GlossEntry[];
}
export interface Gloss {
	/** The whole run's reading. */
	reading: string;
	words: GlossWord[];
	/** The dictionary's credit line, which its licence asks for wherever its senses are shown. */
	credit?: string;
}
