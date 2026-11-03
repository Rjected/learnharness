"use client";

/**
 * The one audio player: Anki card sounds, Gemini TTS, and
 * the browser's own voice as the last resort. A single shared <audio>
 * element is "unlocked" by the first tap so later programmatic plays (a
 * card's autoplay after a network fetch) are allowed on iOS Safari.
 */

import { ankiMediaUrl, type AnkiAvTag } from "@/src/core";

// A 0.1s silent WAV — played inside the first user gesture to unlock audio.
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

let element: HTMLAudioElement | null = null;
let unlocked = false;
let generation = 0;

function audio(): HTMLAudioElement {
	element ??= new Audio();
	return element;
}

/** Call from any pointer/key handler; idempotent. */
export function unlockAudio(): void {
	if (unlocked || typeof window === "undefined") return;
	unlocked = true;
	const a = audio();
	a.src = SILENCE;
	void a.play().catch(() => {
		unlocked = false;
	});
}

export function stopAudio(): void {
	generation++;
	if (element) element.pause();
	if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}

/** The lesson this page shows, so audio costs land on its meter (null off a lesson page). */
export function currentChatId(): string | null {
	if (typeof window === "undefined") return null;
	return /^\/chat\/(chat_[\w-]+)/.exec(window.location.pathname)?.[1] ?? null;
}

/** Tell the open lesson its audio usage may have changed (the stats meter refetches). */
export function notifyAudioUsage(): void {
	if (typeof window !== "undefined") window.dispatchEvent(new Event("lh:audio-usage"));
}

/** The URL of the server TTS clip for this text (cached server-side). */
export function ttsUrl(text: string, opts: { lang: string; slow?: boolean }): string {
	const params = new URLSearchParams({ text, lang: opts.lang });
	if (opts.slow) params.set("slow", "1");
	const chat = currentChatId();
	if (chat) params.set("chat", chat);
	return `/api/tts?${params}`;
}

function playUrl(url: string, gen: number): Promise<void> {
	return new Promise((resolve, reject) => {
		if (gen !== generation) return resolve();
		const a = audio();
		const done = () => {
			a.onended = a.onerror = null;
			resolve();
		};
		a.onended = done;
		a.onerror = () => {
			a.onended = a.onerror = null;
			reject(new Error(`audio failed: ${url}`));
		};
		a.src = url;
		a.play().catch(reject);
	});
}

function speakWithBrowser(text: string, lang: string, slow: boolean, gen: number): Promise<void> {
	return new Promise((resolve) => {
		const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
		if (!synth || gen !== generation) return resolve();
		const u = new SpeechSynthesisUtterance(text);
		u.lang = lang.replace("_", "-");
		u.rate = slow ? 0.7 : 1;
		u.onend = u.onerror = () => resolve();
		synth.speak(u);
	});
}

/** Speak text in `lang` (a BCP-47 tag): server TTS first, the browser's voice if that fails. */
export async function speak(text: string, opts: { lang: string; slow?: boolean }): Promise<void> {
	stopAudio();
	const gen = generation;
	const lang = opts.lang.replace("_", "-");
	try {
		await playUrl(ttsUrl(text, { lang, slow: opts.slow }), gen);
		notifyAudioUsage();
	} catch {
		await speakWithBrowser(text, lang, !!opts.slow, gen);
	}
}

/** Play a card side's av tags in order (Anki's autoplay). */
export async function playAvTags(tags: AnkiAvTag[]): Promise<void> {
	stopAudio();
	const gen = generation;
	for (const tag of tags) {
		if (gen !== generation) return;
		try {
			if (tag.kind === "sound") await playUrl(ankiMediaUrl(tag.file), gen);
			else await playUrl(ttsUrl(tag.text, { lang: tag.lang }), gen);
		} catch {
			if (tag.kind === "tts") await speakWithBrowser(tag.text, tag.lang, false, gen);
		}
	}
}
