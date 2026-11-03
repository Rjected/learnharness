/**
 * The server half of the teacher's Anki tools:
 *   - ankiLookup: what the learner already knows, from their real review state
 *   - ankiAddProposal: one proposed card → a Basic note in the studied
 *     language's deck, with audio (their existing recording when Anki has
 *     one, else Gemini TTS, stored into Anki's media folder)
 */

import crypto from "node:crypto";
import { ankiAddDeck, type AnkiAddResult, type AnkiCardProposal, type AnkiToolPort } from "../core/anki.ts";
import { LANGUAGES } from "../core/languages.ts";
import { ankiAudioFor, ankiInvoke, AnkiOfflineError, readAnkiConfig } from "./anki.ts";
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

async function overview(): Promise<string> {
	const decks = (await ankiInvoke<string[]>("deckNames")).filter((d) => d !== "Default");
	const queries = (d: string) => [
		`"deck:${escapeSearch(d)}" -"deck:${escapeSearch(d)}::*" is:new`,
		`"deck:${escapeSearch(d)}" -"deck:${escapeSearch(d)}::*" is:learn`,
		`"deck:${escapeSearch(d)}" -"deck:${escapeSearch(d)}::*" is:review prop:ivl<21`,
		`"deck:${escapeSearch(d)}" -"deck:${escapeSearch(d)}::*" is:review prop:ivl>=21`,
	];
	const results = await ankiInvoke<{ result: number[] }[]>("multi", {
		actions: decks.flatMap((d) => queries(d).map((query) => ({ action: "findCards", version: 6, params: { query } }))),
	});
	const lines = decks.flatMap((d, i) => {
		const [n, l, y, m] = results.slice(i * 4, i * 4 + 4).map((r) => r.result.length);
		return n! + l! + y! + m! === 0 ? [] : [`- ${d}: ${m} mature, ${y} young, ${l} learning, ${n} not yet studied`];
	});
	return `The learner's Anki collection (mature = review interval 21+ days):\n${lines.join("\n")}`;
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

export const ankiToolPort: AnkiToolPort = { lookup: ankiLookup };

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
