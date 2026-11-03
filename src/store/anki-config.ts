/**
 * Persistence for the Anki review config: data/anki.json —
 * read-modify-write, NOT a ledger. Shape, defaults and sanitizer live in
 * src/core/anki.ts; this module only moves bytes.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { DEFAULT_ANKI_CONFIG, sanitizeAnkiConfig, type AnkiConfig } from "../core/anki.ts";

export const ANKI_CONFIG_FILE = path.join(PATHS.data, "anki.json");

export function readAnkiConfig(): AnkiConfig {
	try {
		return sanitizeAnkiConfig(JSON.parse(fs.readFileSync(ANKI_CONFIG_FILE, "utf-8")));
	} catch {
		return { ...DEFAULT_ANKI_CONFIG }; // never written / corrupt → defaults
	}
}

export function writeAnkiConfig(raw: unknown): AnkiConfig {
	const config = sanitizeAnkiConfig(raw);
	fs.mkdirSync(path.dirname(ANKI_CONFIG_FILE), { recursive: true });
	fs.writeFileSync(ANKI_CONFIG_FILE, JSON.stringify(config, null, "\t"), "utf-8");
	return config;
}
