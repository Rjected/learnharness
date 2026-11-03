/**
 * The audio usage ledger: data/audio-usage.jsonl, one line
 * per paid Gemini TTS / transcription call — append-only evidence; dollars
 * are derived at read time (src/core/audio-usage.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { AudioUsageEntry } from "../core/audio-usage.ts";

export const AUDIO_USAGE_FILE = path.join(PATHS.data, "audio-usage.jsonl");

export function appendAudioUsage(entry: AudioUsageEntry): void {
	fs.mkdirSync(path.dirname(AUDIO_USAGE_FILE), { recursive: true });
	fs.appendFileSync(AUDIO_USAGE_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
}

export function readAudioUsage(): AudioUsageEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(AUDIO_USAGE_FILE, "utf-8");
	} catch {
		return [];
	}
	return raw.split("\n").flatMap((line) => {
		if (!line.trim()) return [];
		try {
			return [JSON.parse(line) as AudioUsageEntry];
		} catch {
			return []; // a torn last line never breaks the meter
		}
	});
}
