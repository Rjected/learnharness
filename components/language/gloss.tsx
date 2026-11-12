"use client";

/**
 * The reading popup for a run of the studied language: the run's reading
 * (pinyin, kana), then each word with its reading and dictionary senses.
 *
 * Hover on a mouse, tap on touch, like Yomitan. Only teacher prose and
 * post-answer reveals opt in (GlossScope); question blocks and problem
 * statements stay bare so the popup never hands out hints. Data comes from
 * GET /api/language/gloss (src/server/gloss.ts), whose dictionary downloads
 * on first use.
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import type { Gloss } from "@/src/core";

const GlossContext = createContext(false);

export function GlossScope({ children }: { children: ReactNode }) {
	return <GlossContext.Provider value={true}>{children}</GlossContext.Provider>;
}

export function useGlossScope(): boolean {
	return useContext(GlossContext);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const cache = new Map<string, Promise<Gloss>>();

function loadGloss(text: string): Promise<Gloss> {
	let p = cache.get(text);
	if (!p) {
		p = fetch(`/api/language/gloss?text=${encodeURIComponent(text)}`).then(async (r) => {
			const body = await r.json();
			if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
			return body as Gloss;
		});
		p.catch(() => cache.delete(text)); // a failed lookup can be retried on the next open
		cache.set(text, p);
	}
	return p;
}

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 200;

/** `lang` tags the popup's words (it renders in a portal, outside the run's own lang). */
export function GlossPopup({ text, lang, children }: { text: string; lang: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [gloss, setGloss] = useState<Gloss | null>(null);
	const [error, setError] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const lastPointer = useRef<string>("mouse");

	useEffect(() => {
		if (!open || gloss) return;
		let live = true;
		loadGloss(text).then((g) => live && setGloss(g), (e: Error) => live && setError(e.message));
		return () => { live = false; };
	}, [open, gloss, text]);
	useEffect(() => () => clearTimeout(timer.current), []);

	const later = (next: boolean, ms: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(next), ms);
	};
	const hoverIn = (e: React.PointerEvent) => { if (e.pointerType === "mouse") later(true, HOVER_OPEN_MS); };
	const hoverOut = (e: React.PointerEvent) => { if (e.pointerType === "mouse") later(false, HOVER_CLOSE_MS); };

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Anchor asChild>
				<span
					className="lh-say-gloss cursor-help decoration-muted-foreground/50 decoration-dotted underline-offset-4 hover:underline"
					onPointerDown={(e) => { lastPointer.current = e.pointerType; }}
					onPointerEnter={hoverIn}
					onPointerLeave={hoverOut}
					onClick={(e) => {
						// A tap toggles; a mouse click just keeps the hover popup open.
						e.stopPropagation();
						clearTimeout(timer.current);
						setOpen((o) => (lastPointer.current === "mouse" ? true : !o));
					}}
				>
					{children}
				</span>
			</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					onOpenAutoFocus={(e) => e.preventDefault()}
					onPointerEnter={(e) => { if (e.pointerType === "mouse") clearTimeout(timer.current); }}
					onPointerLeave={hoverOut}
					className="z-50 max-h-[min(24rem,60dvh)] w-max max-w-[min(24rem,calc(100vw-24px))] overflow-y-auto rounded-xl border bg-card p-3 text-sm shadow-lg"
				>
					{error ? (
						<div className="text-muted-foreground">Couldn’t look this up: {error}</div>
					) : !gloss ? (
						<div className="text-muted-foreground">…</div>
					) : (
						<GlossBody gloss={gloss} lang={lang} />
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** Senses shown before "+N more": dictionaries don't list the common sense first (号's "day of the month" is 8th). */
const SHOWN_SENSES = 4;

function Senses({ defs }: { defs: string[] }) {
	const [all, setAll] = useState(false);
	const hidden = defs.length - SHOWN_SENSES;
	return (
		<>
			{(all ? defs : defs.slice(0, SHOWN_SENSES)).join("; ")}
			{hidden > 0 && !all && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						setAll(true);
					}}
					className="block py-0.5 text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
				>
					+{hidden} more
				</button>
			)}
		</>
	);
}

function GlossBody({ gloss, lang }: { gloss: Gloss; lang: string }) {
	// Every word of the language, read or not (a name JMdict lacks still says "not in dictionary"); punctuation drops.
	const words = gloss.words.filter((w) => w.reading || CJK.test(w.text));
	return (
		<div className="lh-prose">
			{words.length > 1 && <div className="mb-2 border-b pb-2 text-[15px] text-foreground">{gloss.reading}</div>}
			<ul className="m-0 list-none space-y-1.5 p-0">
				{words.map((w, i) => (
					<li key={i} className="leading-snug">
						<span className="text-base text-foreground" lang={lang}>{w.text}</span>{" "}
						<span className="text-muted-foreground">{w.reading}</span>
						{w.entries.length === 0 ? (
							<div className="text-xs text-muted-foreground/70">not in dictionary</div>
						) : (
							w.entries.map((e, j) => (
								<div key={j} className="text-xs text-foreground/70">
									{(w.entries.length > 1 || e.reading.replace(/\s/g, "").toLowerCase() !== w.reading.replace(/'/g, "").toLowerCase()) && (
										<span className="mr-1 text-muted-foreground">{e.reading}</span>
									)}
									<Senses defs={e.defs} />
								</div>
							))
						)}
					</li>
				))}
			</ul>
			{gloss.credit && <div className="mt-2 text-[10px] text-muted-foreground/50">{gloss.credit}</div>}
		</div>
	);
}
