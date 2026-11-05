/**
 * The teacher's Anki tools, registered while a language is studied. Anki
 * stays the learner's spaced-repetition engine; these let a lesson build on
 * what the learner already reviews, and hand new material back to it.
 *
 *   anki_lookup         read-only — which words/characters the learner knows
 *   anki_cards          read-only — one slice of their cards: due, new next, known…
 *   anki_propose_cards  no side effect — renders cards with an "Add to Anki"
 *                       button each; the LEARNER decides what gets added
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { ANKI_CARD_SETS, type AnkiCardSet, type AnkiToolPort } from "../../core/anki.ts";
import type { LanguageProfile } from "../../core/languages.ts";

/** What the Anki tools need: the learner's collection and the language it's for. */
export interface AnkiToolsContext {
	port: AnkiToolPort;
	language: LanguageProfile;
}

export function ankiTools({ port, language }: AnkiToolsContext): Record<string, AgentTool<any>> {
	const lookupInput = Type.Object({
		terms: Type.Array(Type.String({ minLength: 1 }), {
			maxItems: 40,
			description: `${language.label} words or short phrases, written as in ${language.label} text. Empty array = an overview of the whole collection.`,
		}),
	});
	const cardsInput = Type.Object({
		which: Type.Union(
			Object.keys(ANKI_CARD_SETS).map((k) => Type.Literal(k as AnkiCardSet)),
			{ description: Object.entries(ANKI_CARD_SETS).map(([k, v]) => `${k} = ${v}`).join("; ") },
		),
		deck: Type.Optional(Type.String({ minLength: 1, description: "Only decks whose name contains this, e.g. \"Refold\" or \"speaking\"." })),
		days: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "Window for forgotten and due_soon." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Most words to list (default 30)." })),
	});
	const proposeInput = Type.Object({
		cards: Type.Array(
			Type.Object({
				kind: Type.Union([Type.Literal("speak"), Type.Literal("produce")], {
					description: `speak = sees the ${language.label}, says it aloud; produce = sees the English, says it in ${language.label}.`,
				}),
				text: Type.String({ minLength: 1, description: language.cardText }),
				reading: Type.String({ minLength: 1, description: language.cardReading }),
				meaning: Type.String({ minLength: 1, description: "Natural English meaning." }),
				note: Type.Optional(Type.String({ description: "One short line on the point this card practices (optional)." })),
			}),
			{ minItems: 1, maxItems: 10 },
		),
	});
	return {
		anki_lookup: {
			name: "anki_lookup",
			label: "anki_lookup",
			description:
				"Check the learner's Anki collection (their daily flashcard reviews). For each term: whether it is in Anki and how well it is known " +
				"(new / learning / young / mature with the review interval). Pass an empty array for an overview: every deck's counts, due cards " +
				"and settings, plus their recent progress (days studied, streak, cards per day, how much they remember). Read-only.",
			parameters: lookupInput,
			execute: serverExecute("anki_lookup", lookupInput, async ({ terms }): Promise<string> => port.lookup(terms)),
		},
		anki_cards: {
			name: "anki_cards",
			label: "anki_cards",
			description:
				"List one slice of the learner's Anki cards, word by word, each with its reading, meaning, an example sentence when the card " +
				"has one, its state (interval, times forgotten) and deck. Use it to plan practice around their reviews: pre-teach next_new " +
				"and due words in sentences built from known ones, so the Anki session that follows is recall, not first contact. Read-only.",
			parameters: cardsInput,
			execute: serverExecute("anki_cards", cardsInput, async (query): Promise<string> => port.cards(query)),
		},
		anki_propose_cards: {
			name: "anki_propose_cards",
			label: "anki_propose_cards",
			description:
				"Offer flashcards for what this lesson taught. They render in the lesson with an 'Add to Anki' button each — the learner chooses; " +
				"nothing is added by this call. Audio is generated automatically. Don't re-propose material anki_lookup shows they already have.",
			parameters: proposeInput,
			execute: serverExecute("anki_propose_cards", proposeInput, async ({ cards }): Promise<string> =>
				`Proposed ${cards.length} card(s). The learner adds the ones they want with the button on each — don't assume any were added.`,
			),
		},
	};
}

/** The read-only Anki tools, for phases that only assess (the probe). */
export function ankiReadTools(ctx: AnkiToolsContext): Record<string, AgentTool<any>> {
	const { anki_lookup, anki_cards } = ankiTools(ctx);
	return { anki_lookup: anki_lookup!, anki_cards: anki_cards! };
}
