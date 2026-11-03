"use client";

/**
 * The Review page: Anki's due cards, one at a time.
 * Anki does the scheduling — this view shows the front, reveals the back,
 * and sends the grade through /api/anki/answer. Keys: Space/Enter reveals
 * (and grades Good), 1–4 grade, R replays audio.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon, SlidersHorizontalIcon, Volume2Icon } from "lucide-react";
import { ANKI_EASE_LABELS, type AnkiEase, type AnkiNextResponse, type AnkiQueueCounts } from "@/src/core";
import { SidebarToggle } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { playAvTags, stopAudio, unlockAudio } from "@/components/language/player";
import { CardFrame, type FrameMessage } from "@/components/review/card-frame";
import { DeckSettings } from "@/components/review/deck-settings";

type View =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| (AnkiNextResponse & { kind: "next" });

const EASE_STYLE: Record<AnkiEase, string> = {
	1: "border-red-500/40 hover:bg-red-500/15",
	2: "border-amber-500/40 hover:bg-amber-500/15",
	3: "border-emerald-500/40 hover:bg-emerald-500/15",
	4: "border-sky-500/40 hover:bg-sky-500/15",
};

function Counts({ counts }: { counts: AnkiQueueCounts }) {
	return (
		<span className="flex gap-3 font-mono text-sm tabular-nums" aria-label="Cards left">
			<span className="text-sky-400" title="New">{counts.new}</span>
			<span className="text-red-400" title="Learning">{counts.learning}</span>
			<span className="text-emerald-400" title="Review">{counts.review}</span>
		</span>
	);
}

export function ReviewSession() {
	const [view, setView] = useState<View>({ kind: "loading" });
	const [revealed, setRevealed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [answered, setAnswered] = useState(0);
	const [syncNote, setSyncNote] = useState<string | null>(null);
	const [showDecks, setShowDecks] = useState(false);
	const synced = useRef(false);

	const card = view.kind === "next" && view.state === "card" ? view.card : null;

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/anki/next", { cache: "no-store" });
			if (!res.ok) throw new Error(`Review server error (${res.status})`);
			const next = (await res.json()) as AnkiNextResponse;
			setRevealed(false);
			setView({ kind: "next", ...next });
			if (next.state === "card") void playAvTags(next.card.questionAv);
		} catch (err) {
			setView({ kind: "error", message: err instanceof Error ? err.message : String(err) });
		}
	}, []);

	useEffect(() => {
		void load();
		return () => stopAudio();
	}, [load]);

	const sync = useCallback(async () => {
		setSyncNote("Syncing to AnkiWeb…");
		const res = await fetch("/api/anki/sync", { method: "POST" }).catch(() => null);
		setSyncNote(res?.ok ? "Synced to AnkiWeb" : "Sync failed — Anki will sync next time it opens");
	}, []);

	// Finished (or only waiting on learning steps): push today's work to AnkiWeb once.
	const finished = view.kind === "next" && (view.state === "done" || view.state === "waiting");
	useEffect(() => {
		if (finished && answered > 0 && !synced.current) {
			synced.current = true;
			void sync();
		}
	}, [finished, answered, sync]);

	// Waiting on a learning step: check again when it comes due.
	const dueAt = view.kind === "next" && view.state === "waiting" ? view.dueAt : null;
	useEffect(() => {
		if (dueAt === null) return;
		const ms = Math.max(5_000, dueAt * 1000 - Date.now() - 20 * 60 * 1000);
		const t = setTimeout(() => void load(), Math.min(ms, 60_000));
		return () => clearTimeout(t);
	}, [dueAt, load]);

	const reveal = useCallback(() => {
		if (!card || revealed) return;
		setRevealed(true);
		void playAvTags(card.answerAv);
	}, [card, revealed]);

	const grade = useCallback(
		async (ease: AnkiEase) => {
			if (!card || !revealed || busy) return;
			setBusy(true);
			stopAudio();
			try {
				const res = await fetch("/api/anki/answer", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ cardId: card.cardId, ease }),
				});
				if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Answer failed");
				setAnswered((n) => n + 1);
				synced.current = false;
				await load();
			} catch (err) {
				setView({ kind: "error", message: err instanceof Error ? err.message : String(err) });
			} finally {
				setBusy(false);
			}
		},
		[card, revealed, busy, load],
	);

	const replay = useCallback(() => {
		if (card) void playAvTags(revealed ? card.answerAv : card.questionAv);
	}, [card, revealed]);

	const onKey = useCallback(
		(key: string) => {
			if (key === " " || key === "Enter") {
				if (revealed) void grade(3);
				else reveal();
			} else if (["1", "2", "3", "4"].includes(key)) void grade(Number(key) as AnkiEase);
			else if (key === "r" || key === "R") replay();
		},
		[revealed, grade, reveal, replay],
	);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if ([" ", "Enter", "1", "2", "3", "4", "r", "R"].includes(e.key)) {
				e.preventDefault();
				onKey(e.key);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onKey]);

	const onFrame = useCallback(
		(m: FrameMessage) => {
			if (!card) return;
			if (m.lh === "play") {
				const tags = m.side === "q" ? card.questionAv : card.answerAv;
				const tag = tags[m.idx];
				if (tag) void playAvTags([tag]);
			} else if (m.lh === "key") onKey(m.key);
			else if (m.lh === "tap" && !revealed) reveal();
		},
		[card, onKey, reveal, revealed],
	);

	const counts = view.kind === "next" && view.state !== "offline" ? view.counts : null;

	return (
		<div className="relative flex h-dvh flex-col" onPointerDown={unlockAudio}>
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<header className="relative flex h-13 shrink-0 items-center gap-3 px-3">
				<SidebarToggle />
				<h1 className="text-xs uppercase tracking-widest text-muted-foreground">Review</h1>
				<span className="flex-1" />
				{counts && <Counts counts={counts} />}
				<Button variant="ghost" size="icon-sm" aria-label="Choose decks" onClick={() => setShowDecks((v) => !v)} className="lh-no-drag">
					<SlidersHorizontalIcon />
				</Button>
				<Button variant="ghost" size="icon-sm" aria-label="Replay audio" onClick={replay} disabled={!card} className="lh-no-drag">
					<Volume2Icon />
				</Button>
			</header>

			<main className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
				<div className="mx-auto w-full max-w-2xl">
					{showDecks && (
						<div className="mb-4">
							<DeckSettings
								onClose={() => setShowDecks(false)}
								onSaved={() => {
									setShowDecks(false);
									void load();
								}}
							/>
						</div>
					)}
					{view.kind === "loading" && <p className="mt-16 text-center text-sm text-muted-foreground">Loading cards…</p>}
					{view.kind === "error" && (
						<Notice title="Something went wrong" body={view.message} action={() => void load()} />
					)}
					{view.kind === "next" && view.state === "offline" && (
						<Notice title="Anki isn't open" body={view.message} action={() => void load()} />
					)}
					{view.kind === "next" && view.state === "done" && (
						<Notice
							title="All done for today"
							body={[answered ? `${answered} card${answered === 1 ? "" : "s"} reviewed.` : "Nothing due.", syncNote].filter(Boolean).join(" ")}
						/>
					)}
					{view.kind === "next" && view.state === "waiting" && (
						<Notice
							title="Waiting on learning steps"
							body={`The next card comes back at ${new Date(view.dueAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. ${syncNote ?? ""}`}
							action={() => void load()}
						/>
					)}
					{card && (
						<div className="flex flex-col gap-2 pt-1">
							<CardFrame html={revealed ? card.answer : card.question} css={card.css} onMessage={onFrame} />
							<p className="truncate text-xs text-muted-foreground/70">{card.deckName.split("::").pop()}</p>
						</div>
					)}
				</div>
			</main>

			{card && (
				<footer className="shrink-0 border-t border-border bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
					<div className="mx-auto w-full max-w-2xl">
						{revealed ? (
							<div className="grid grid-cols-4 gap-2">
								{([1, 2, 3, 4] as AnkiEase[]).map((ease) => (
									<button
										key={ease}
										type="button"
										disabled={busy}
										onClick={() => void grade(ease)}
										className={cn(
											"flex flex-col items-center rounded-md border py-2 text-sm transition-colors disabled:opacity-50",
											EASE_STYLE[ease],
										)}
									>
										<span className="text-xs text-muted-foreground">{card.nextReviews[ease - 1]?.replace(/[⁨⁩]/g, "")}</span>
										<span>{ANKI_EASE_LABELS[ease]}</span>
									</button>
								))}
							</div>
						) : (
							<Button className="h-12 w-full" onClick={reveal}>
								Show answer
							</Button>
						)}
					</div>
				</footer>
			)}
		</div>
	);
}

function Notice({ title, body, action }: { title: string; body: string; action?: () => void }) {
	return (
		<div className="mt-16 flex flex-col items-center gap-3 text-center">
			<h2 className="text-lg">{title}</h2>
			<p className="max-w-md text-sm text-muted-foreground">{body}</p>
			{action && (
				<Button variant="outline" size="sm" onClick={action}>
					<RefreshCwIcon /> Try again
				</Button>
			)}
		</div>
	);
}
