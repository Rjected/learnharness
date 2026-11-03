/**
 * Anki review — the pure half. Anki stays the scheduling
 * engine; the server drives it through AnkiConnect (src/server/anki.ts) and
 * the Review page renders the cards. Everything here is browser-safe:
 * the config shape, the card wire shapes, and the template walk that maps
 * Anki's `[anki:play:q:0]` placeholders back to sound files / TTS text.
 */

// ─── Config (data/anki.json) ───────────────────────────────────────────────

export interface AnkiConfig {
	/** AnkiConnect endpoint on the laptop. */
	url: string;
	/** Decks to review (full names, "Parent::Child"). Empty = every deck with cards. */
	decks: string[];
	/** Deck that teacher-created cards go into; "" = "<Language>::LearnHarness" (ankiAddDeck). */
	addDeck: string;
}

export const DEFAULT_ANKI_CONFIG: AnkiConfig = {
	url: "http://127.0.0.1:8765",
	decks: [],
	addDeck: "",
};

/** Where the teacher's cards go: the configured deck, else one per studied language. */
export function ankiAddDeck(config: AnkiConfig, languageLabel: string): string {
	return config.addDeck || `${languageLabel}::LearnHarness`;
}

export function sanitizeAnkiConfig(raw: unknown): AnkiConfig {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const url = typeof r.url === "string" && /^https?:\/\//.test(r.url.trim()) ? r.url.trim() : DEFAULT_ANKI_CONFIG.url;
	const decks = Array.isArray(r.decks)
		? [...new Set(r.decks.filter((d): d is string => typeof d === "string" && d.trim() !== "").map((d) => d.trim()))]
		: DEFAULT_ANKI_CONFIG.decks;
	const addDeck = typeof r.addDeck === "string" ? r.addDeck.trim() : DEFAULT_ANKI_CONFIG.addDeck;
	return { url, decks, addDeck };
}

// ─── Wire shapes (server → Review page) ────────────────────────────────────

/** One playable thing on a card side, in Anki's own av order. */
export type AnkiAvTag = { kind: "sound"; file: string } | { kind: "tts"; lang: string; text: string };

export interface AnkiCardView {
	cardId: number;
	deckName: string;
	modelName: string;
	/** Rendered HTML with placeholders already swapped for play buttons. */
	question: string;
	answer: string;
	css: string;
	questionAv: AnkiAvTag[];
	answerAv: AnkiAvTag[];
	/** Anki's interval labels for Again / Hard / Good / Easy. */
	nextReviews: string[];
}

export interface AnkiQueueCounts {
	learning: number;
	review: number;
	new: number;
}

export type AnkiNextResponse =
	| { state: "card"; card: AnkiCardView; counts: AnkiQueueCounts }
	/** Only learning cards remain and the next is not due yet (unix seconds). */
	| { state: "waiting"; dueAt: number; counts: AnkiQueueCounts }
	| { state: "done"; counts: AnkiQueueCounts }
	| { state: "offline"; message: string };

export type AnkiEase = 1 | 2 | 3 | 4;

export const ANKI_EASE_LABELS: Record<AnkiEase, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

// ─── Template walk: placeholders → av tags ─────────────────────────────────

const SOUND_RE = /\[sound:([^\]]+)\]/g;

/** Every `[sound:x]` in a field value, in order. */
export function soundFiles(value: string): string[] {
	return [...value.matchAll(SOUND_RE)].map((m) => m[1] ?? "");
}

function stripHtml(value: string): string {
	return value
		.replace(SOUND_RE, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.trim();
}

/**
 * The av tags one side of a card produces, in the order Anki numbers them.
 * A Mustache-lite walk of the card template: `{{#F}}…{{/F}}` and
 * `{{^F}}…{{/F}}` sections, `{{F}}` / `{{filter:F}}` fields (their
 * `[sound:]` tags), and `{{tts lang:F}}`. `{{FrontSide}}` contributes
 * nothing — on the answer side its sounds keep their `q:` numbering.
 */
export function avTagsForTemplate(template: string, fields: Record<string, string>): AnkiAvTag[] {
	const out: AnkiAvTag[] = [];
	const tokens = template.split(/(\{\{[^}]*\}\})/);
	// Each open section: does its body render?
	const stack: { name: string; on: boolean }[] = [];
	const live = () => stack.every((s) => s.on);
	const filled = (name: string) => stripHtml(fields[name] ?? "") !== "" || soundFiles(fields[name] ?? "").length > 0;

	for (const tok of tokens) {
		if (!tok.startsWith("{{")) {
			if (live()) out.push(...soundFiles(tok).map((file) => ({ kind: "sound" as const, file })));
			continue;
		}
		const inner = tok.slice(2, -2).trim();
		if (inner.startsWith("#") || inner.startsWith("^")) {
			const name = inner.slice(1).trim();
			stack.push({ name, on: inner.startsWith("#") ? filled(name) : !filled(name) });
			continue;
		}
		if (inner.startsWith("/")) {
			stack.pop();
			continue;
		}
		if (!live() || inner === "FrontSide") continue;
		const tts = /^tts\s+([\w-]+)(?:\s[^:]*)?:(.+)$/.exec(inner);
		if (tts) {
			const [, lang = "zh_CN", field = ""] = tts;
			const text = stripHtml(fields[field.trim()] ?? "");
			if (text) out.push({ kind: "tts", lang, text });
			continue;
		}
		const name = inner.includes(":") ? inner.slice(inner.lastIndexOf(":") + 1).trim() : inner;
		out.push(...soundFiles(fields[name] ?? "").map((file) => ({ kind: "sound" as const, file })));
	}
	return out;
}

/** The URL the Review page loads a media file from. */
export function ankiMediaUrl(file: string): string {
	return `/api/anki/media/${encodeURIComponent(file)}`;
}

/**
 * Rendered card HTML → the HTML the review iframe shows: `<style>` blocks
 * dropped (the card CSS ships separately), play placeholders turned into
 * buttons carrying their side + index, and `<img src>` pointed at the
 * media route.
 */
export function rewriteCardHtml(html: string): string {
	return html
		.replace(/<style>[\s\S]*?<\/style>/g, "")
		.replace(
			/\[anki:play:([qa]):(\d+)\]/g,
			(_, side: string, idx: string) =>
				`<button type="button" class="lh-play" data-side="${side}" data-idx="${idx}" aria-label="Play audio">▶</button>`,
		)
		.replace(/(<img\b[^>]*?\ssrc=)(["'])([^"']+)\2/g, (m, pre: string, q: string, src: string) =>
			/^(https?:|data:|\/)/.test(src) ? m : `${pre}${q}${ankiMediaUrl(decodeURIComponent(src))}${q}`,
		);
}

/** Learning-step cards Anki would show early when nothing else is left (its default learn-ahead). */
export const ANKI_LEARN_AHEAD_SECONDS = 20 * 60;

// ─── Teacher ↔ Anki (anki_lookup / anki_propose_cards) ─────────────────────

/** What the agent layer may ask of Anki — injected by the server (the agent never imports it). */
export interface AnkiToolPort {
	/** Per-term status lines, or the collection overview when `terms` is empty. */
	lookup(terms: string[]): Promise<string>;
}

/** A card the teacher proposes; the learner adds it with one click (a Basic note). */
export interface AnkiCardProposal {
	/** speak: see the target language, say it aloud. produce: see the English, say it in the target language. */
	kind: "speak" | "produce";
	/** The sentence or phrase in the studied language. */
	text: string;
	/** Its reading (pinyin, kana). */
	reading: string;
	/** Natural English meaning. */
	meaning: string;
	/** Optional usage/grammar note shown on the back. */
	note?: string;
}

/** Parse, don't cast: the proposal tool's input as the renderer sees it. Lessons from
 *  before the language layer used chinese/pinyin/english; they still render. */
export function parseAnkiProposals(input: unknown): AnkiCardProposal[] {
	const cards = (input as { cards?: unknown } | null)?.cards;
	if (!Array.isArray(cards)) return [];
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	return cards.flatMap((c): AnkiCardProposal[] => {
		const r = (c ?? {}) as Record<string, unknown>;
		const card: AnkiCardProposal = {
			kind: r.kind === "produce" ? "produce" : "speak",
			text: str(r.text) || str(r.chinese),
			reading: str(r.reading) || str(r.pinyin),
			meaning: str(r.meaning) || str(r.english),
			...(str(r.note) ? { note: str(r.note) } : {}),
		};
		return card.text && card.meaning ? [card] : [];
	});
}

export type AnkiAddResult = { ok: true; noteId: number } | { ok: false; duplicate: boolean; error: string };
