"use client";

/** Each Anki deck's role in LearnHarness, and where teacher-made cards go (data/anki.json). */

import { useEffect, useState } from "react";
import { ankiAddDeck, ankiDeckRole, ANKI_DECK_ROLES, type AnkiConfig, type AnkiDeckRole } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStudyProfile } from "@/components/language/status";

/** The config as the browser sees it: the suspended card ids stay on the server. */
type ClientConfig = Omit<AnkiConfig, "pausedCards">;

const parentOf = (deck: string) => deck.split("::").slice(0, -1).join("::");

export function DeckSettings({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
	const [config, setConfig] = useState<ClientConfig | null>(null);
	const [decks, setDecks] = useState<string[] | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const profile = useStudyProfile();

	useEffect(() => {
		void fetch("/api/anki/config", { cache: "no-store" })
			.then((r) => r.json() as Promise<{ config: ClientConfig; decks: string[] | null }>)
			.then((d) => {
				setConfig(d.config);
				setDecks(d.decks);
			});
	}, []);

	if (!config) return <p className="text-sm text-muted-foreground">Loading…</p>;

	/** "" = no role of its own: follow the parent. */
	const setRole = (deck: string, role: AnkiDeckRole | "") => {
		const roles = { ...config.roles };
		if (role) roles[deck] = role;
		else delete roles[deck];
		setConfig({ ...config, roles });
	};

	const save = async () => {
		setSaving(true);
		setError(null);
		const res = await fetch("/api/anki/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(config),
		}).catch(() => null);
		setSaving(false);
		if (res?.ok) onSaved();
		else setError(((await res?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "Couldn't save — is LearnHarness running?");
	};

	return (
		<div className="flex flex-col gap-4 rounded-lg border border-border p-4 text-sm">
			<div>
				<h2 className="mb-1 font-medium">Decks</h2>
				<p className="mb-2 text-xs text-muted-foreground">
					Daily: your main review. Separate: its own session. Paused: suspended in Anki until you resume it. Off: not used here.
				</p>
				{decks === null ? (
					<p className="text-muted-foreground">Open Anki to see your decks.</p>
				) : (
					<ul className="flex flex-col gap-1">
						{decks.map((deck) => {
							const sub = deck.includes("::");
							return (
								<li key={deck} className="flex items-center gap-2" style={{ paddingLeft: `${(deck.split("::").length - 1) * 1}rem` }}>
									<span className="min-w-0 flex-1">{deck.split("::").pop()}</span>
									<select
										aria-label={`Role of ${deck}`}
										value={config.roles[deck] ?? (sub ? "" : ankiDeckRole(config, deck))}
										onChange={(e) => setRole(deck, e.target.value as AnkiDeckRole | "")}
										className="w-48 shrink-0 rounded-md border border-border bg-background px-2 py-1 text-xs"
									>
										{sub && <option value="">Same as parent ({ANKI_DECK_ROLES[ankiDeckRole(config, parentOf(deck))]})</option>}
										{(Object.keys(ANKI_DECK_ROLES) as AnkiDeckRole[]).map((role) => (
											<option key={role} value={role}>
												{ANKI_DECK_ROLES[role]}
											</option>
										))}
									</select>
								</li>
							);
						})}
					</ul>
				)}
			</div>
			<label className="flex flex-col gap-1">
				<span className="font-medium">Deck for cards the teacher adds</span>
				<Input
					value={config.addDeck}
					placeholder={ankiAddDeck({ ...config, pausedCards: [], addDeck: "" }, profile?.label ?? "Chinese")}
					onChange={(e) => setConfig({ ...config, addDeck: e.target.value })}
				/>
			</label>
			{error && <p className="text-xs text-red-400">{error}</p>}
			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onClose}>
					Cancel
				</Button>
				<Button size="sm" onClick={() => void save()} disabled={saving}>
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>
		</div>
	);
}
