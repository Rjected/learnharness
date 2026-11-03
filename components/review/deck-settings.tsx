"use client";

/** Which Anki decks Review pulls from, and where teacher-made cards go (data/anki.json). */

import { useEffect, useState } from "react";
import { ankiAddDeck, type AnkiConfig } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStudyProfile } from "@/components/language/status";

export function DeckSettings({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
	const [config, setConfig] = useState<AnkiConfig | null>(null);
	const [decks, setDecks] = useState<string[] | null>(null);
	const [saving, setSaving] = useState(false);
	const profile = useStudyProfile();

	useEffect(() => {
		void fetch("/api/anki/config", { cache: "no-store" })
			.then((r) => r.json() as Promise<{ config: AnkiConfig; decks: string[] | null }>)
			.then((d) => {
				setConfig(d.config);
				setDecks(d.decks);
			});
	}, []);

	if (!config) return <p className="text-sm text-muted-foreground">Loading…</p>;

	const toggle = (deck: string) =>
		setConfig({
			...config,
			decks: config.decks.includes(deck) ? config.decks.filter((d) => d !== deck) : [...config.decks, deck],
		});

	const save = async () => {
		setSaving(true);
		await fetch("/api/anki/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(config),
		});
		setSaving(false);
		onSaved();
	};

	return (
		<div className="flex flex-col gap-4 rounded-lg border border-border p-4 text-sm">
			<div>
				<h2 className="mb-1 font-medium">Decks to review</h2>
				<p className="mb-2 text-xs text-muted-foreground">None ticked = every deck. Ticking a parent includes its subdecks.</p>
				{decks === null ? (
					<p className="text-muted-foreground">Open Anki to see your decks.</p>
				) : (
					<ul className="flex flex-col gap-1">
						{decks.map((deck) => (
							<li key={deck} style={{ paddingLeft: `${(deck.split("::").length - 1) * 1}rem` }}>
								<label className="flex items-center gap-2">
									<input type="checkbox" checked={config.decks.includes(deck)} onChange={() => toggle(deck)} />
									{deck.split("::").pop()}
								</label>
							</li>
						))}
					</ul>
				)}
			</div>
			<label className="flex flex-col gap-1">
				<span className="font-medium">Deck for cards the teacher adds</span>
				<Input
					value={config.addDeck}
					placeholder={ankiAddDeck({ ...config, addDeck: "" }, profile?.label ?? "Chinese")}
					onChange={(e) => setConfig({ ...config, addDeck: e.target.value })}
				/>
			</label>
			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onClose}>
					Cancel
				</Button>
				<Button size="sm" onClick={() => void save()} disabled={saving}>
					Save
				</Button>
			</div>
		</div>
	);
}
