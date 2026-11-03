"use client";

/**
 * The studied language and whether speech is set up (GET /api/language), one
 * snapshot shared by every speaker button, reading popup, the Review link and
 * the dictation chip. Re-read whenever the agent settings or the keys change.
 */

import { useSyncExternalStore } from "react";
import { LANGUAGES, type LanguageProfile, type LanguageStatus } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";

let status: LanguageStatus | null = null;
let loading = false;
let watching = false;
const listeners = new Set<() => void>();

function load(): void {
	if (loading || typeof window === "undefined") return;
	loading = true;
	if (!watching) {
		watching = true;
		onSettingsSaved((section) => (section === "agent" || section === "keys") && load());
	}
	fetch("/api/language", { cache: "no-store" })
		.then((r) => (r.ok ? (r.json() as Promise<LanguageStatus>) : null))
		.then((next) => {
			if (!next) return;
			status = next;
			for (const listener of listeners) listener();
		})
		.catch(() => undefined)
		.finally(() => {
			loading = false;
		});
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (!status) load();
	return () => listeners.delete(listener);
}

/** null until the first answer arrives (render the plain text meanwhile). */
export function useLanguageStatus(): LanguageStatus | null {
	return useSyncExternalStore(subscribe, () => status, () => null);
}

export function useStudyProfile(): LanguageProfile | null {
	const language = useLanguageStatus()?.language;
	return language ? LANGUAGES[language] : null;
}

/** The latest snapshot for non-React callers (the dictation engine pick); starts a load if none yet. */
export function languageStatus(): LanguageStatus | null {
	if (!status) load();
	return status;
}
