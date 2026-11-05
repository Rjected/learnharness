/**
 * The teacher's Anki tools, registered while a language is studied. Anki
 * stays the learner's spaced-repetition engine; these let a lesson build on
 * what the learner already reviews, and hand new material back to it.
 *
 *   anki_lookup         read-only — which words/characters the learner knows
 *   anki_due            read-only — the words they're working on right now
 *   anki_propose_cards  no side effect — renders cards with an "Add to Anki"
 *                       button each; the LEARNER decides what gets added
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { AnkiToolPort } from "../../core/anki.ts";
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
	const dueInput = Type.Object({
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "Most words to list (default 30)." })),
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
		anki_due: {
			name: "anki_due",
			label: "anki_due",
			description:
				"List the words the learner is working on in Anki: forgotten this week, in learning, then due today (most overdue first), " +
				"each with its state and deck. Use it to practise or build a lesson on their current cards. Read-only.",
			parameters: dueInput,
			execute: serverExecute("anki_due", dueInput, async ({ limit }): Promise<string> => port.due(limit ?? 30)),
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
