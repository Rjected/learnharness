/**
 * The server half of the teacher's Anki tools:
 *   - ankiLookup: what the learner already knows, from their real review state
 *   - ankiDue: what they're working on — forgotten, learning and due words
 *   - ankiAddProposal: one proposed card → a Basic note in the studied
 *     language's deck, with audio (their existing recording when Anki has
 *     one, else Gemini TTS, stored into Anki's media folder)
 */

import crypto from "node:crypto";
import { ankiAddDeck, type AnkiAddResult, type AnkiCardProposal, type AnkiToolPort } from "../core/anki.ts";
import { LANGUAGES } from "../core/languages.ts";
import { ankiAudioFor, ankiInvoke, AnkiOfflineError, CJK, readAnkiConfig } from "./anki.ts";
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
		return [`- ${d}: ${m} mature, ${y} young, ${l} learning, ${n} not yet studied; ${due} due now${settings}`];
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
		"The learner's Anki collection (mature = review interval 21+ days):",
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

interface DueCard extends CardState {
	due: number;
	lapses: number;
	fields: Record<string, { value: string; order: number }>;
}

const plain = (html: string) =>
	html.replace(/\[sound:[^\]]*\]/g, "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * What a card is about, read from its note: the first field in the studied script, plus the first
 * reading-like and meaning-like fields by name (Pinyin, Reading…; Meaning, Back…), shortened.
 */
function describeNote(fields: DueCard["fields"]): string {
	const ordered = Object.entries(fields)
		.sort(([, a], [, b]) => a.order - b.order)
		.map(([name, f]) => [name, plain(f.value)] as const)
		.filter(([, v]) => v);
	const word = ordered.find(([, v]) => CJK.test(v))?.[1];
	if (!word) return "";
	const pick = (re: RegExp) => ordered.find(([name, v]) => re.test(name) && v !== word)?.[1];
	const reading = pick(/pinyin|reading|kana|furigana/i);
	const meaning = pick(/meaning|english|definition|back|prompt/i);
	const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
	return [word, reading && `(${short(reading)})`, meaning && `“${short(meaning)}”`].filter(Boolean).join(" ");
}

/**
 * The words the learner is working on: forgotten in the last week, in learning, then due reviews,
 * most overdue first. One line per word (a word with several cards, e.g. reading and speaking, counts once).
 */
export async function ankiDue(limit: number): Promise<string> {
	try {
		// The decks picked for the Review page, else everything.
		const scope = readAnkiConfig().decks.map((d) => `"deck:${escapeSearch(d)}"`).join(" OR ") || "-deck:Default";
		const [lapsed, learning, due] = await ankiInvoke<{ result: number[] }[]>("multi", {
			actions: ["rated:7:1", "is:learn", "is:due is:review -is:learn"].map((q) => ({
				action: "findCards",
				version: 6,
				params: { query: `(${scope}) -is:suspended ${q}` },
			})),
		});
		const ids = [...new Set([...lapsed!.result, ...learning!.result, ...due!.result])];
		if (ids.length === 0) return "Nothing is due in Anki right now, and nothing was forgotten this week.";
		const cards = await ankiInvoke<DueCard[]>("cardsInfo", {
			cards: ids,
			fields: ["cardId", "interval", "type", "queue", "deckName", "due", "lapses", "fields"],
		});
		const lapsedIds = new Set(lapsed!.result);
		const rank = (c: DueCard) => (lapsedIds.has(c.cardId) ? 0 : c.type === 1 || c.type === 3 ? 1 : 2);
		cards.sort((a, b) => rank(a) - rank(b) || a.due - b.due);
		const seen = new Set<string>();
		const lines: string[] = [];
		for (const c of cards) {
			const word = describeNote(c.fields);
			if (!word || seen.has(word)) continue;
			seen.add(word);
			if (lines.length < limit) {
				const state = rank(c) === 0 ? "forgotten this week" : rank(c) === 1 ? "learning" : `due (interval ${c.interval}d)`;
				lines.push(`- ${word}: ${state}${c.lapses > 1 ? `, forgotten ${c.lapses} times` : ""} — ${c.deckName.split("::").pop()}`);
			}
		}
		const more = seen.size - lines.length;
		return `${lines.join("\n")}${more > 0 ? `\n…and ${more} more.` : ""}\nPractising these here doesn't grade them in Anki — they still review there.`;
	} catch (err) {
		if (err instanceof AnkiOfflineError) return "Anki is closed on the learner's laptop, so their due cards can't be checked right now.";
		throw err;
	}
}

export const ankiToolPort: AnkiToolPort = { lookup: ankiLookup, due: ankiDue };

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
