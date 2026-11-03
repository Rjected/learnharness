/**
 * Audio usage pricing: Gemini TTS clips and dictation
 * transcriptions, priced from Google's published paid-tier rates (USD per
 * 1M tokens, ai.google.dev/gemini-api/docs/pricing, checked 2026-10-26).
 * The model catalog the turns are priced from has neither the TTS models
 * nor separate audio-input rates, hence this table. Pure, browser-safe.
 */

interface Rates {
	/** Text (and image/video) input. */
	input: number;
	/** Audio input, when Google prices it differently from text. */
	audioInput?: number;
	output: number;
}

interface PriceEntry extends Rates {
	/** Rates from 2027-01-01 (Google's announced increase), when announced. */
	from2027?: Rates;
}

const RATES: Record<string, PriceEntry> = {
	"gemini-3.8-flash-tts": { input: 0.5, output: 9, from2027: { input: 1, output: 18 } },
	"gemini-3.8-flash-lite-tts": { input: 0.5, output: 6, from2027: { input: 1, output: 12 } },
	"gemini-3.1-flash-tts-preview": { input: 1, output: 20 },
	"gemini-2.5-flash-preview-tts": { input: 0.5, output: 10 },
	"gemini-2.5-pro-preview-tts": { input: 1, output: 20 },
	"gemini-3.8-flash": { input: 0.75, output: 3.75, from2027: { input: 1.5, output: 7.5 } },
	"gemini-3.6-flash": { input: 0.75, output: 3.75, from2027: { input: 1.5, output: 7.5 } },
	"gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
	"gemini-3.1-flash-lite": { input: 0.25, audioInput: 0.5, output: 1.5 },
	"gemini-3-flash-preview": { input: 0.5, audioInput: 1, output: 3 },
	"gemini-2.5-flash": { input: 0.3, audioInput: 1, output: 2.5 },
	"gemini-2.5-flash-lite": { input: 0.1, audioInput: 0.3, output: 0.4 },
};

const PRICE_CHANGE_2027 = Date.UTC(2027, 0, 1);

/** Longest known id the model version starts with ("gemini-3.8-flash-001" → gemini-3.8-flash). */
export function audioRateKey(model: string): string | undefined {
	const id = model.replace(/^models\//, "");
	return Object.keys(RATES)
		.sort((a, b) => b.length - a.length)
		.find((key) => id === key || id.startsWith(`${key}-`));
}

export interface AudioUsageEntry {
	/** ISO time of the call. */
	at: string;
	kind: "tts" | "stt";
	/** The lesson it belongs to, when it was made from one. */
	chatId: string | null;
	/** The model Google reports it ran (modelVersion), else the one requested. */
	model: string;
	textInputTokens: number;
	audioInputTokens: number;
	/** Output tokens, thinking included (Google bills thinking as output). */
	outputTokens: number;
}

/** Dollars for one call, or null when the model isn't in the price table. */
export function audioCallCost(e: AudioUsageEntry): number | null {
	const key = audioRateKey(e.model);
	if (!key) return null;
	const entry = RATES[key]!;
	const rates = entry.from2027 && Date.parse(e.at) >= PRICE_CHANGE_2027 ? entry.from2027 : entry;
	const audioRate = rates.audioInput ?? rates.input;
	return (e.textInputTokens * rates.input + e.audioInputTokens * audioRate + e.outputTokens * rates.output) / 1_000_000;
}

export interface AudioPricing {
	cost: number;
	/** Generated speech clips (cached replays and Anki recordings are free and not counted). */
	clips: number;
	transcriptions: number;
	/** Calls whose model isn't in the price table. */
	unpriced: number;
}

export function audioPricing(entries: AudioUsageEntry[]): AudioPricing {
	const out: AudioPricing = { cost: 0, clips: 0, transcriptions: 0, unpriced: 0 };
	for (const e of entries) {
		if (e.kind === "tts") out.clips++;
		else out.transcriptions++;
		const c = audioCallCost(e);
		if (c === null) out.unpriced++;
		else out.cost += c;
	}
	return out;
}

/** Gemini's usageMetadata → token counts for the ledger. */
export function geminiUsageTokens(usage: unknown): Pick<AudioUsageEntry, "textInputTokens" | "audioInputTokens" | "outputTokens"> {
	const u = (usage ?? {}) as {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		promptTokensDetails?: { modality?: string; tokenCount?: number }[];
	};
	const prompt = u.promptTokenCount ?? 0;
	const audio = (u.promptTokensDetails ?? []).filter((d) => d.modality === "AUDIO").reduce((n, d) => n + (d.tokenCount ?? 0), 0);
	return {
		textInputTokens: Math.max(0, prompt - audio),
		audioInputTokens: audio,
		outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
	};
}
