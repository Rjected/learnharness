/**
 * The Anki bridge. Anki stays the scheduling engine: this
 * module asks AnkiConnect (the add-on's HTTP API on the laptop) what is due,
 * renders one card at a time for the Review page, and hands grades back via
 * `answerCards` — so FSRS, review history and AnkiWeb sync all stay Anki's.
 *
 * The queue mirrors Anki's v3 order closely enough for daily reviews:
 * learning cards that are due, then reviews (capped by each deck's review
 * limit), then new cards (capped by its new-card limit), and finally a
 * learning card due within the learn-ahead window when nothing else is left.
 */

import fs from "node:fs";
import path from "node:path";
import {
	ANKI_LEARN_AHEAD_SECONDS,
	avTagsForTemplate,
	rewriteCardHtml,
	type AnkiCardView,
	type AnkiConfig,
	type AnkiEase,
	type AnkiNextResponse,
	type AnkiQueueCounts,
} from "../core/anki.ts";
import { readAnkiConfig, writeAnkiConfig } from "../store/anki-config.ts";
import { bytesResponse } from "./media-response.ts";

export { readAnkiConfig, writeAnkiConfig };

export class AnkiOfflineError extends Error {}

// AnkiConnect's HTTP server handles one connection at a time and drops
// concurrent ones, so every call goes through this chain.
let lane: Promise<unknown> = Promise.resolve();

/** One AnkiConnect call. Network failure → AnkiOfflineError (Anki closed). */
export function ankiInvoke<T>(action: string, params: Record<string, unknown> = {}, config = readAnkiConfig()): Promise<T> {
	const run = lane.then(async () => {
		let res: Response;
		try {
			res = await fetch(config.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, version: 6, params }),
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			throw new AnkiOfflineError("Anki isn't running on the laptop (AnkiConnect unreachable). Open Anki and try again.");
		}
		const body = (await res.json()) as { result: T; error: string | null };
		if (body.error) throw new Error(`AnkiConnect ${action}: ${body.error}`);
		return body.result;
	});
	lane = run.catch(() => undefined);
	return run;
}

/** Several AnkiConnect calls in one request (the `multi` action). */
async function ankiMulti<T extends unknown[]>(actions: { action: string; params?: Record<string, unknown> }[], config: AnkiConfig): Promise<T> {
	// Each sub-action needs `version` for AnkiConnect to wrap its result as {result, error}.
	const versioned = actions.map((a) => ({ ...a, version: 6 }));
	const results = await ankiInvoke<{ result: unknown; error: string | null }[]>("multi", { actions: versioned }, config);
	return results.map((r, i) => {
		if (r.error) throw new Error(`AnkiConnect ${actions[i]?.action}: ${r.error}`);
		return r.result;
	}) as T;
}

// ─── Raw AnkiConnect shapes (only the fields we read) ──────────────────────

interface RawCardInfo {
	cardId: number;
	note: number;
	deckName: string;
	modelName: string;
	ord: number;
	queue: number;
	due: number;
	question: string;
	answer: string;
	css: string;
	fields: Record<string, { value: string; order: number }>;
	nextReviews: string[];
}

interface RawDeckConfig {
	new: { perDay: number };
	rev: { perDay: number };
}

const q = (deck: string) => `"deck:${deck.replace(/"/g, '\\"')}"`;
/** Cards sitting directly in this deck, not its subdecks. */
const own = (deck: string) => `${q(deck)} -${q(`${deck}::*`)}`;
const ACTIVE = "-is:suspended -is:buried";

let deckCache: { at: number; names: string[] } | undefined;

/** The decks whose own limits apply: every deck at or under the selection. */
async function leafDecks(config: AnkiConfig): Promise<string[]> {
	if (!deckCache || Date.now() - deckCache.at > 60_000) {
		deckCache = { at: Date.now(), names: await ankiInvoke<string[]>("deckNames", {}, config) };
	}
	const all = deckCache.names;
	const roots = config.decks.length ? config.decks : all.filter((d) => !d.includes("::"));
	return all.filter((d) => roots.some((r) => d === r || d.startsWith(`${r}::`)));
}

interface Queue {
	learnReady: number[];
	learnWaiting: { id: number; due: number }[];
	review: number[];
	fresh: number[];
}

const PER_DECK = 7;

async function buildQueue(config: AnkiConfig, now = Date.now() / 1000): Promise<Queue> {
	const queue: Queue = { learnReady: [], learnWaiting: [], review: [], fresh: [] };
	const decks = await leafDecks(config);
	// One request for every deck (AnkiConnect round trips are the slow part).
	const results = await ankiMulti<unknown[]>(
		decks.flatMap((deck) => {
			const find = (query: string) => ({ action: "findCards", params: { query: `${own(deck)} ${query}` } });
			return [
				find(`is:learn ${ACTIVE}`),
				find(`is:learn is:due ${ACTIVE}`),
				find(`is:due is:review -is:learn ${ACTIVE}`),
				find(`is:new ${ACTIVE}`),
				find("introduced:1"),
				find("rated:1"),
				{ action: "getDeckConfig", params: { deck } },
			];
		}),
		config,
	);
	const learning: number[] = [];
	const learnDue = new Set<number>();
	decks.forEach((_, i) => {
		const [learn, due, review, fresh, introduced, rated, deckConf] = results.slice(i * PER_DECK, (i + 1) * PER_DECK) as [
			number[], number[], number[], number[], number[], number[], RawDeckConfig | false,
		];
		const newPerDay = deckConf ? deckConf.new.perDay : 20;
		const revPerDay = deckConf ? deckConf.rev.perDay : 200;
		const reviewedToday = Math.max(0, rated.length - introduced.length);
		queue.review.push(...review.slice(0, Math.max(0, revPerDay - reviewedToday)));
		queue.fresh.push(...fresh.slice(0, Math.max(0, newPerDay - introduced.length)));
		learning.push(...learn);
		for (const id of due) learnDue.add(id);
	});
	if (learning.length) {
		const infos = await ankiInvoke<Pick<RawCardInfo, "cardId" | "queue" | "due">[]>(
			"cardsInfo",
			{ cards: learning, fields: ["cardId", "queue", "due"] },
			config,
		);
		for (const c of infos) {
			// queue 1 = intraday learning (due is a unix timestamp); queue 3 = day-learning
			if (c.queue === 1 && c.due > now) queue.learnWaiting.push({ id: c.cardId, due: c.due });
			else if (c.queue === 1 || learnDue.has(c.cardId)) queue.learnReady.push(c.cardId);
		}
	}
	queue.learnReady.sort((a, b) => a - b);
	queue.learnWaiting.sort((a, b) => a.due - b.due);
	return queue;
}

function countsOf(queue: Queue): AnkiQueueCounts {
	return { learning: queue.learnReady.length + queue.learnWaiting.length, review: queue.review.length, new: queue.fresh.length };
}

const templateCache = new Map<string, { Front: string; Back: string }[]>();

async function templatesFor(modelName: string, config: AnkiConfig) {
	let templates = templateCache.get(modelName);
	if (!templates) {
		const raw = await ankiInvoke<Record<string, { Front: string; Back: string }>>("modelTemplates", { modelName }, config);
		templates = Object.values(raw);
		templateCache.set(modelName, templates);
	}
	return templates;
}

/** One card, ready for the Review page. */
export async function ankiCardView(cardId: number, config = readAnkiConfig()): Promise<AnkiCardView> {
	const [card] = await ankiInvoke<RawCardInfo[]>("cardsInfo", { cards: [cardId] }, config);
	if (!card) throw new Error(`Anki has no card ${cardId}`);
	const templates = await templatesFor(card.modelName, config);
	// Cloze note types have one template for every ord.
	const template = templates[card.ord] ?? templates[0];
	const fields = Object.fromEntries(Object.entries(card.fields).map(([k, v]) => [k, v.value]));
	return {
		cardId: card.cardId,
		deckName: card.deckName,
		modelName: card.modelName,
		question: rewriteCardHtml(card.question),
		answer: rewriteCardHtml(card.answer),
		css: card.css,
		questionAv: template ? avTagsForTemplate(template.Front, fields) : [],
		answerAv: template ? avTagsForTemplate(template.Back, fields) : [],
		nextReviews: card.nextReviews,
	};
}

/** What the Review page should show next. */
export async function ankiNext(): Promise<AnkiNextResponse> {
	const config = readAnkiConfig();
	try {
		const now = Date.now() / 1000;
		const queue = await buildQueue(config, now);
		const counts = countsOf(queue);
		const waiting = queue.learnWaiting[0];
		const next =
			queue.learnReady[0] ??
			queue.review[0] ??
			queue.fresh[0] ??
			(waiting && waiting.due - now <= ANKI_LEARN_AHEAD_SECONDS ? waiting.id : undefined);
		if (next !== undefined) return { state: "card", card: await ankiCardView(next, config), counts };
		if (waiting) return { state: "waiting", dueAt: waiting.due, counts };
		return { state: "done", counts };
	} catch (err) {
		if (err instanceof AnkiOfflineError) return { state: "offline", message: err.message };
		throw err;
	}
}

/** Due counts only (the sidebar badge). Null when Anki is closed. */
export async function ankiCounts(): Promise<AnkiQueueCounts | null> {
	try {
		return countsOf(await buildQueue(readAnkiConfig()));
	} catch {
		return null;
	}
}

export async function ankiAnswer(cardId: number, ease: AnkiEase): Promise<void> {
	const [ok] = await ankiInvoke<boolean[]>("answerCards", { answers: [{ cardId, ease }] });
	if (!ok) throw new Error(`Anki refused the answer for card ${cardId}`);
}

/** Push the collection to AnkiWeb so AnkiMobile sees today's reviews. */
export async function ankiSync(): Promise<void> {
	await ankiInvoke("sync");
}

export async function ankiDeckNames(): Promise<string[]> {
	return ankiInvoke<string[]>("deckNames");
}

let mediaDir: string | undefined;

/**
 * Absolute path of one file in Anki's media folder, or null when the name
 * is unsafe or missing. Only bare file names are served — no path parts.
 */
export async function ankiMediaPath(name: string): Promise<string | null> {
	if (!name || name !== path.basename(name) || name.startsWith(".")) return null;
	mediaDir ??= await ankiInvoke<string>("getMediaDirPath");
	const file = path.join(mediaDir, name);
	return fs.existsSync(file) ? file : null;
}

const MEDIA_TYPES: Record<string, string> = {
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".wav": "audio/wav",
	".webm": "audio/webm",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

/** Serve one media file (audio plays on the phone thanks to Range support). */
export async function ankiMediaResponse(name: string, range: string | null): Promise<Response> {
	let file: string | null;
	try {
		file = await ankiMediaPath(name);
	} catch {
		return new Response("Anki isn't running", { status: 503 });
	}
	if (!file) return new Response("Not found", { status: 404 });
	const type = MEDIA_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
	return bytesResponse(fs.readFileSync(file), type, range);
}

// ─── Reusing the learner's own Anki audio ──────────────────────────────────

/** CJK text: the runs the speaker buttons play (Chinese, Japanese). */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const plain = (v: string) =>
	v
		.replace(/\[sound:[^\]]+\]/g, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.trim();
/** Comparison key: no spaces or trailing sentence punctuation. */
const keyOf = (text: string) => plain(text).replace(/\s+/g, "").replace(/[。！？!?.，,]+$/u, "");
/** A field name without case, spaces or punctuation ("Sentence Audio" → "sentenceaudio"). */
const squash = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Which audio field voices which text field, by name, for any note type. An
 * audio field's stem is its name minus "audio"/"sound"/"slow"; a voiced text
 * field takes the audio whose stem it starts with (Sentence ↔ Sentence Audio,
 * Vocabulary-Kanji ↔ Vocabulary-Audio). A bare "Audio" voices only the first
 * voiced field left over — the headword — never an example sentence beside
 * it. A "slow" audio field is the slow take.
 */
export function pairAudioFields(fieldNames: string[], voiced: (field: string) => boolean): { text: string; audio?: string; slow?: string }[] {
	const audio = fieldNames
		.filter((n) => /audio|sound/i.test(n))
		.map((n) => ({ name: n, stem: squash(n).replace(/audio|sound|slow/g, ""), slow: /slow/i.test(n) }))
		.sort((a, b) => b.stem.length - a.stem.length);
	let bareUsed = false;
	return fieldNames
		.filter((n) => !/audio|sound/i.test(n) && voiced(n))
		.map((text) => {
			let fits = audio.filter((a) => a.stem && squash(text).startsWith(a.stem));
			if (!fits.length && !bareUsed) {
				fits = audio.filter((a) => !a.stem);
				bareUsed = true;
			}
			return { text, audio: fits.find((a) => !a.slow)?.name, slow: fits.find((a) => a.slow)?.name };
		});
}

let audioIndex: { at: number; normal: Map<string, string>; slow: Map<string, string> } | undefined;

async function buildAudioIndex(): Promise<NonNullable<typeof audioIndex>> {
	const normal = new Map<string, string>();
	const slow = new Map<string, string>();
	const ids = await ankiInvoke<number[]>("findNotes", { query: "deck:*" });
	const notes = await ankiInvoke<{ fields: Record<string, { value: string }> }[]>("notesInfo", { notes: ids });
	for (const note of notes) {
		const f = (name: string) => note.fields[name]?.value ?? "";
		const firstSound = (name: string | undefined) => (name ? /\[sound:([^\]]+)\]/.exec(f(name))?.[1] : undefined);
		for (const pair of pairAudioFields(Object.keys(note.fields), (name) => CJK.test(keyOf(f(name))))) {
			const key = keyOf(f(pair.text));
			const file = firstSound(pair.audio);
			if (file && !normal.has(key)) normal.set(key, file);
			const slowFile = firstSound(pair.slow);
			if (slowFile && !slow.has(key)) slow.set(key, slowFile);
		}
	}
	return { at: Date.now(), normal, slow };
}

/** The media file of your own Anki recording for this exact text, if any (index refreshed every 10 min). */
export async function ankiAudioFor(text: string, slow: boolean): Promise<string | null> {
	try {
		if (!audioIndex || Date.now() - audioIndex.at > 10 * 60_000) audioIndex = await buildAudioIndex();
	} catch {
		return null; // Anki closed — fall through to TTS
	}
	const key = keyOf(text);
	return (slow ? audioIndex.slow.get(key) : undefined) ?? (slow ? null : audioIndex.normal.get(key)) ?? null;
}
