/**
 * The server half of the teacher's Anki tools:
 *   - ankiLookup: what the learner already knows, from their real review state
 *   - ankiCards: one slice of their cards (due, new next, known…) with readings, meanings, examples
 *   - ankiAddProposal: one proposed card → a Basic note in the studied
 *     language's deck, with audio (their existing recording when Anki has
 *     one, else Gemini TTS, stored into Anki's media folder)
 */

import crypto from "node:crypto";
import { ankiAddDeck, ankiDeckRole, ankiSessionOf, ANKI_CARD_SETS, type AnkiAddResult, type AnkiCardProposal, type AnkiCardQuery, type AnkiCardSet, type AnkiToolPort } from "../core/anki.ts";
import { LANGUAGES } from "../core/languages.ts";
import { ankiAudioFor, ankiInvoke, AnkiOfflineError, CJK, decksQuery, readAnkiConfig } from "./anki.ts";
import { studyProfile } from "./language.ts";
import { ttsAudio } from "./tts.ts";

const escapeSearch = (t: string) => t.replace(/["\\*_]/g, (c) => `\\${c}`);

interface CardState {
	cardId: number;
	interval: number;
	type: number;
	queue: number;
	deckName: string;
}

function describeBest(cards: CardState[]): string {
	if (cards.length === 0) return "not in Anki";
	const active = cards.filter((c) => c.queue !== -1);
	const pool = active.length ? active : cards;
	const best = pool.reduce((a, b) => (b.interval > a.interval ? b : a));
	const decks = [...new Set(cards.map((c) => c.deckName.split("::").pop()))].join(", ");
	const status =
		best.type === 0
			? "in Anki but not studied yet"
			: best.type === 1 || best.type === 3
				? "learning (just introduced or recently forgotten)"
				: best.interval >= 21
					? `known well (mature, interval ${best.interval}d)`
					: `learned recently (interval ${best.interval}d)`;
	return `${status}${active.length ? "" : ", suspended"} — ${decks}`;
}

/** Anki's day as YYYY-MM-DD, `back` days ago (its day starts at 4am local, like getNumCardsReviewedByDay). */
function ankiDay(back: number): string {
	const d = new Date(Date.now() - 4 * 3_600_000 - back * 86_400_000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function overview(): Promise<string> {
	const config = readAnkiConfig();
	const decks = (await ankiInvoke<string[]>("deckNames")).filter((d) => d !== "Default");
	const own = (d: string) => `"deck:${escapeSearch(d)}" -"deck:${escapeSearch(d)}::*"`;
	const deckQueries = ["is:new", "is:learn", "is:review prop:ivl<21", "is:review prop:ivl>=21", "is:due -is:suspended"];
	const recentQueries = ["rated:30 -is:new", "rated:30:1 -is:new", "introduced:30", "rated:7", "introduced:7"];
	const find = (query: string) => ({ action: "findCards", version: 6, params: { query } });
	const results = await ankiInvoke<{ result: unknown }[]>("multi", {
		actions: [
			...decks.flatMap((d) => [...deckQueries.map((q) => find(`${own(d)} ${q}`)), { action: "getDeckConfig", version: 6, params: { deck: d } }]),
			...recentQueries.map((q) => find(`-deck:Default ${q}`)),
			{ action: "getNumCardsReviewedByDay", version: 6 },
		],
	});
	const count = (i: number) => (results[i]!.result as number[]).length;
	const stride = deckQueries.length + 1;
	const lines = decks.flatMap((d, i) => {
		const [n, l, y, m, due] = deckQueries.map((_, k) => count(i * stride + k));
		if (n! + l! + y! + m! === 0) return [];
		const conf = results[i * stride + deckQueries.length]!.result as { new: { perDay: number }; desiredRetention: number } | false;
		const settings = conf ? `; ${conf.new.perDay} new/day, target retention ${Math.round(conf.desiredRetention * 100)}%` : "";
		return [`- ${d} [${ankiDeckRole(config, d)}]: ${m} mature, ${y} young, ${l} learning, ${n} not yet studied; ${due} due now${settings}`];
	});

	const base = decks.length * stride;
	const [reviewed30, failed30, new30, answered7, new7] = recentQueries.map((_, k) => count(base + k));
	const byDay = new Map(results[base + recentQueries.length]!.result as [string, number][]);
	const studiedIn = (n: number) => Array.from({ length: n }, (_, k) => ankiDay(k)).filter((d) => byDay.has(d)).length;
	let streak = byDay.has(ankiDay(0)) ? 1 : 0; // today not done yet doesn't break the streak
	while (byDay.has(ankiDay(streak + (byDay.has(ankiDay(0)) ? 0 : 1)))) streak++;
	const remembered = reviewed30 ? `${Math.round((1 - failed30! / reviewed30) * 100)}%` : "—";
	const progress = [
		`Last 7 days: studied on ${studiedIn(7)} day(s); ${answered7} cards reviewed, ${new7} of them new.`,
		`Last 30 days: studied on ${studiedIn(30)} day(s); ${new30} new cards; ${remembered} of reviewed cards remembered (not failed).`,
		`Streak: ${streak} day(s); last studied ${[...byDay.keys()].sort().pop() ?? "never"}.`,
		`Cards answered per day, last 14 days: ${Array.from({ length: 14 }, (_, k) => ankiDay(13 - k))
			.map((d) => `${d.slice(5)} ${byDay.get(d) ?? 0}`)
			.join(", ")}.`,
	];
	return [
		"The learner's Anki collection (mature = review interval 21+ days). Each deck's role is in brackets — daily: their main review; separate: practised only in its own sessions; paused: suspended in Anki; off: not used in LearnHarness.",
		...lines,
		"",
		"Progress:",
		...progress.map((line) => `- ${line}`),
	].join("\n");
}

export async function ankiLookup(terms: string[]): Promise<string> {
	try {
		if (terms.length === 0) return await overview();
		const unique = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
		const actions = unique.flatMap((t) => [
			{
				action: "findCards",
				version: 6,
				// A card whose field is exactly the term (any note type, any field name).
				params: { query: `"*:${escapeSearch(t)}"` },
			},
			{ action: "findCards", version: 6, params: { query: `"${escapeSearch(t)}"` } },
		]);
		const found = await ankiInvoke<{ result: number[] }[]>("multi", { actions });
		const headIds = unique.map((_, i) => found[i * 2]!.result);
		const allIds = [...new Set(headIds.flat())];
		const states = allIds.length
			? await ankiInvoke<CardState[]>("cardsInfo", {
					cards: allIds,
					fields: ["cardId", "interval", "type", "queue", "deckName"],
				})
			: [];
		const byId = new Map(states.map((s) => [s.cardId, s]));
		const lines = unique.map((t, i) => {
			const cards = headIds[i]!.flatMap((id) => byId.get(id) ?? []);
			const elsewhere = found[i * 2 + 1]!.result.length - cards.length;
			return `- ${t}: ${describeBest(cards)}${elsewhere > 0 ? `; appears in ${elsewhere} other card(s), e.g. example sentences` : ""}`;
		});
		return lines.join("\n");
	} catch (err) {
		if (err instanceof AnkiOfflineError) return "Anki is closed on the learner's laptop, so their review state can't be checked right now.";
		throw err;
	}
}

interface ListedCard extends CardState {
	due: number;
	lapses: number;
	fields: Record<string, { value: string; order: number }>;
}

const plain = (html: string) =>
	html.replace(/\[sound:[^\]]*\]/g, "").replace(/<br\s*\/?>|<\/(div|p|li)>/gi, "; ").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const short = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * What a card is about, read from its note: the first field in the studied script, plus the first
 * reading-, meaning- and example-like fields by name (Pinyin; Meaning, Back; Sentence, Examples).
 * Undefined when no field is in the studied script (not a language card).
 */
function describeNote(fields: ListedCard["fields"]): { word: string; line: string } | undefined {
	const ordered = Object.entries(fields)
		.sort(([, a], [, b]) => a.order - b.order)
		.map(([name, f]) => [name, plain(f.value)] as const)
		.filter(([, v]) => v);
	const word = ordered.find(([, v]) => CJK.test(v))?.[1];
	if (!word) return undefined;
	const pick = (re: RegExp, cjk = false) => ordered.find(([name, v]) => re.test(name) && v !== word && (!cjk || CJK.test(v)))?.[1];
	const reading = pick(/pinyin|reading|kana|furigana/i);
	const meaning = pick(/meaning|english|definition|back|prompt/i);
	const example = pick(/sentence|example/i, true);
	const line = [word, reading && `(${short(reading)})`, meaning && `“${short(meaning)}”`, example && `e.g. ${short(example, 80)}`]
		.filter(Boolean)
		.join(" ");
	return { word, line };
}

const SET_QUERY: Record<AnkiCardSet, (days: number) => string> = {
	due: () => "is:due is:review -is:learn",
	learning: () => "is:learn",
	forgotten: (days) => `rated:${days}:1`,
	due_soon: (days) => `is:review -is:learn prop:due>0 prop:due<=${days}`,
	next_new: () => "is:new -is:buried",
	known: () => "is:review -is:learn prop:ivl>=7",
	struggling: () => "prop:lapses>=3",
};
const SET_ORDER: Record<AnkiCardSet, (a: ListedCard, b: ListedCard) => number> = {
	due: (a, b) => a.due - b.due,
	learning: (a, b) => b.lapses - a.lapses,
	forgotten: (a, b) => b.lapses - a.lapses,
	due_soon: (a, b) => a.due - b.due,
	next_new: (a, b) => a.due - b.due, // a new card's due is its queue position; see byIntroductionDay
	known: (a, b) => b.interval - a.interval,
	struggling: (a, b) => b.lapses - a.lapses,
};

function stateOf(c: ListedCard): string {
	const state =
		c.type === 0 ? "new" : c.type === 1 ? "learning" : c.type === 3 ? "relearning" : `${c.interval >= 21 ? "mature" : "young"}, interval ${c.interval}d`;
	return `${state}${c.lapses ? `, forgotten ${c.lapses}×` : ""}`;
}

/**
 * New cards in the order Anki introduces them: each deck gives its own new-cards-per-day, day after
 * day; paused decks (0/day) give none. Labels each card with the day it should come up.
 */
async function byIntroductionDay(cards: ListedCard[]): Promise<{ card: ListedCard; day: number }[]> {
	const decks = [...new Set(cards.map((c) => c.deckName))];
	const configs = await ankiInvoke<{ result: { new: { perDay: number } } | false }[]>("multi", {
		actions: decks.map((deck) => ({ action: "getDeckConfig", version: 6, params: { deck } })),
	});
	const queues = decks
		.map((deck, i) => ({ perDay: configs[i]!.result ? configs[i]!.result.new.perDay : 0, cards: cards.filter((c) => c.deckName === deck) }))
		.filter((q) => q.perDay > 0);
	const out: { card: ListedCard; day: number }[] = [];
	for (let day = 1; queues.some((q) => q.cards.length); day++) {
		for (const q of queues) for (const card of q.cards.splice(0, q.perDay)) out.push({ card, day });
	}
	return out;
}

/** One slice of the learner's cards, one line per word (sibling cards of a word count once). */
export async function ankiCards({ which, deck, days, limit = 30 }: AnkiCardQuery): Promise<string> {
	try {
		const span = Math.max(1, Math.round(days ?? (which === "due_soon" ? 3 : 7)));
		// The daily decks; with a deck filter, separate decks too (paused ones are suspended anyway).
		const config = readAnkiConfig();
		const inScope = (await ankiInvoke<string[]>("deckNames")).filter((d) => {
			const session = ankiSessionOf(config, d);
			return deck ? session !== undefined : session === null;
		});
		const deckFilter = deck ? ` "deck:*${escapeSearch(deck)}*"` : "";
		const ids = inScope.length
			? await ankiInvoke<number[]>("findCards", { query: `(${decksQuery(inScope)})${deckFilter} -is:suspended ${SET_QUERY[which](span)}` })
			: [];
		const cards = ids.length
			? await ankiInvoke<ListedCard[]>("cardsInfo", {
					cards: ids,
					fields: ["cardId", "interval", "type", "queue", "deckName", "due", "lapses", "fields"],
				})
			: [];
		cards.sort(SET_ORDER[which]);
		const ordered = which === "next_new" ? await byIntroductionDay(cards) : cards.map((card) => ({ card, day: 0 }));
		const seen = new Set<string>();
		const lines: string[] = [];
		for (const { card: c, day } of ordered) {
			const note = describeNote(c.fields);
			if (!note || seen.has(note.word)) continue;
			seen.add(note.word);
			const when = day ? `day ${day}` : stateOf(c);
			if (lines.length < limit) lines.push(`- ${note.line} — ${when} — ${c.deckName.split("::").pop()}`);
		}
		const set = ANKI_CARD_SETS[which].replace("`days` days", `${span} days`).replace(/ \(default \d+\)/, "");
		const title = `${seen.size} word(s) ${set}${deck ? ` in decks matching “${deck}”` : ""}`;
		if (seen.size === 0) return `${title}.`;
		const more = seen.size - lines.length;
		return [`${title}:`, ...lines, ...(more > 0 ? [`…and ${more} more (raise limit, or narrow by deck).`] : [])].join("\n");
	} catch (err) {
		if (err instanceof AnkiOfflineError) return "Anki is closed on the learner's laptop, so their cards can't be listed right now.";
		throw err;
	}
}

export const ankiToolPort: AnkiToolPort = { lookup: ankiLookup, cards: ankiCards };

/** Audio for a card: an existing Anki recording of the same text, else a stored TTS clip. */
async function audioTag(text: string, lang: string, chatId: string | null): Promise<string> {
	const existing = await ankiAudioFor(text, false);
	if (existing) return `[sound:${existing}]`;
	const bytes = await ttsAudio({ text, lang, slow: false }, chatId);
	const name = `lh-tts-${crypto.createHash("sha256").update(`normal\u0000${text}`).digest("hex").slice(0, 24)}.wav`;
	await ankiInvoke("storeMediaFile", { filename: name, data: Buffer.from(bytes).toString("base64") });
	return `[sound:${name}]`;
}

/** `chatId`: the lesson the card came from — its audio cost lands on that lesson's meter. */
export async function ankiAddProposal(card: AnkiCardProposal, chatId: string | null = null): Promise<AnkiAddResult> {
	const profile = studyProfile() ?? LANGUAGES.zh;
	const deckName = ankiAddDeck(readAnkiConfig(), profile.label);
	try {
		await ankiInvoke("createDeck", { deck: deckName });
		const audio = await audioTag(card.text, profile.speech, chatId).catch(() => "");
		// Basic, on purpose: every collection has it, and both card kinds fit Front/Back.
		const answer = `${card.text}<br>${card.reading} ${audio}`;
		const note = card.note ? `<br><small>${card.note}</small>` : "";
		const fields =
			card.kind === "produce"
				? { Front: card.meaning, Back: `${answer}${note}` }
				: { Front: card.text, Back: `${card.reading}<br>${card.meaning} ${audio}${note}` };
		const noteId = await ankiInvoke<number>("addNote", {
			note: { deckName, modelName: "Basic", fields, tags: ["learnharness"], options: { allowDuplicate: false } },
		});
		return { ok: true, noteId };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, duplicate: /duplicate/i.test(message), error: message };
	}
}
