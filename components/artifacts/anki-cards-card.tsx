"use client";

/**
 * anki_propose_cards in the transcript: the teacher's proposed flashcards,
 * each with its own "Add to Anki" button. Nothing is added until the learner
 * clicks; the added state is remembered per device.
 */

import { useEffect, useState } from "react";
import { CheckIcon, LayersIcon, Loader2Icon, PlusIcon, Volume2Icon } from "lucide-react";
import { parseAnkiProposals, type AnkiAddResult, type AnkiCardProposal, type ArtifactPartProps } from "@/src/core";
import { currentChatId, notifyAudioUsage, speak, unlockAudio } from "@/components/language/player";
import { useLanguageStatus, useStudyProfile } from "@/components/language/status";
import { cn } from "@/lib/utils";

type RowState = "idle" | "adding" | "added" | "duplicate" | { error: string };

const storageKey = (toolCallId: string, i: number) => `lh:anki-added:${toolCallId}:${i}`;

function CardRow({ card, toolCallId, index }: { card: AnkiCardProposal; toolCallId: string; index: number }) {
	const [state, setState] = useState<RowState>("idle");
	const profile = useStudyProfile();
	const canSpeak = useLanguageStatus()?.tts === true;

	useEffect(() => {
		try {
			if (localStorage.getItem(storageKey(toolCallId, index))) setState("added");
		} catch {}
	}, [toolCallId, index]);

	const add = async () => {
		setState("adding");
		try {
			const res = await fetch("/api/anki/add", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ card, chatId: currentChatId() }),
			});
			const result = (await res.json()) as AnkiAddResult;
			notifyAudioUsage();
			if (result.ok) {
				setState("added");
				try {
					localStorage.setItem(storageKey(toolCallId, index), String(result.noteId));
				} catch {}
			} else setState(result.duplicate ? "duplicate" : { error: result.error });
		} catch (err) {
			setState({ error: err instanceof Error ? err.message : String(err) });
		}
	};

	return (
		<li className="flex items-start gap-3 border-t border-border/60 py-2.5 first:border-t-0">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="text-lg leading-tight" lang={profile?.speech}>
						{card.text}
					</span>
					{profile && canSpeak && (
						<button
							type="button"
							aria-label={`Play ${card.text}`}
							onClick={() => {
								unlockAudio();
								void speak(card.text, { lang: profile.speech });
							}}
							className="inline-flex size-6 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
						>
							<Volume2Icon className="size-3.5" />
						</button>
					)}
				</div>
				<div className="text-sm text-muted-foreground">{card.reading}</div>
				<div className="text-sm">{card.meaning}</div>
				{card.note && <div className="mt-0.5 text-xs text-muted-foreground/80">{card.note}</div>}
				{typeof state === "object" && <div className="mt-1 text-xs text-destructive">{state.error}</div>}
			</div>
			<div className="flex shrink-0 flex-col items-end gap-1">
				<span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
					{card.kind === "speak" ? "say it" : `English → ${profile?.nativeName ?? "target"}`}
				</span>
				<button
					type="button"
					disabled={state === "adding" || state === "added" || state === "duplicate"}
					onClick={() => void add()}
					className={cn(
						"flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
						state === "added" || state === "duplicate"
							? "border-emerald-500/40 text-emerald-400"
							: "border-border hover:bg-accent disabled:opacity-60",
					)}
				>
					{state === "adding" ? (
						<Loader2Icon className="size-3 animate-spin" />
					) : state === "added" || state === "duplicate" ? (
						<CheckIcon className="size-3" />
					) : (
						<PlusIcon className="size-3" />
					)}
					{state === "added" ? "Added" : state === "duplicate" ? "Already in Anki" : "Add to Anki"}
				</button>
			</div>
		</li>
	);
}

export function AnkiCardsCard({ part }: ArtifactPartProps) {
	const cards = parseAnkiProposals(part.input);
	if (cards.length === 0) return null;
	return (
		<div className="my-3 rounded-lg border border-border bg-card/40 px-3 py-2">
			<div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
				<LayersIcon className="size-3" /> Flashcards for Anki
			</div>
			<ul>
				{cards.map((card, i) => (
					<CardRow key={i} card={card} toolCallId={part.toolCallId} index={i} />
				))}
			</ul>
		</div>
	);
}
