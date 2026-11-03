/**
 * Price Google's moving aliases at the model they point to.
 * `gemini-flash-latest` etc. are repointed by Google over time and the
 * bundled catalog's alias prices go stale (it priced gemini-flash-latest as
 * 3.5 Flash, $1.50/$9, while Google serves 3.8 Flash at $0.75/$3.75).
 *
 * A one-token call returns the serving model in `modelVersion` (cost: a
 * single input token). The answer is cached in data/model-aliases.json and
 * re-checked at most daily; pricing reads the cache synchronously and a
 * stale/missing entry refreshes in the background for the next read.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { keyValue } from "./keys.ts";

const ALIAS_FILE = path.join(PATHS.data, "model-aliases.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface AliasEntry {
	target: string;
	checkedAt: string;
}

let cache: Record<string, AliasEntry> | undefined;
const inFlight = new Set<string>();

function load(): Record<string, AliasEntry> {
	if (!cache) {
		try {
			cache = JSON.parse(fs.readFileSync(ALIAS_FILE, "utf-8")) as Record<string, AliasEntry>;
		} catch {
			cache = {};
		}
	}
	return cache;
}

/** Google aliases we resolve: the `-latest` family. */
export function isGoogleAlias(provider: string, id: string): boolean {
	return provider === "google" && /-latest$/.test(id);
}

/** Ask Google what the alias serves right now (one input token, no output). */
export async function refreshGoogleAlias(id: string): Promise<string | undefined> {
	const key = keyValue("GEMINI_API_KEY");
	if (!key || inFlight.has(id)) return undefined;
	inFlight.add(id);
	try {
		const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, {
			method: "POST",
			headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
			body: JSON.stringify({ contents: [{ parts: [{ text: "Hi" }] }], generationConfig: { maxOutputTokens: 1 } }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return undefined;
		const target = ((await res.json()) as { modelVersion?: string }).modelVersion?.replace(/^models\//, "");
		if (!target || target === id) return undefined;
		const all = load();
		all[id] = { target, checkedAt: new Date().toISOString() };
		fs.mkdirSync(path.dirname(ALIAS_FILE), { recursive: true });
		fs.writeFileSync(ALIAS_FILE, JSON.stringify(all, null, "\t"), "utf-8");
		return target;
	} catch {
		return undefined; // offline: keep pricing at whatever we knew
	} finally {
		inFlight.delete(id);
	}
}

/**
 * The model id to price a Google alias at, from cache (undefined until the
 * first check lands). Kicks off a background refresh when the entry is
 * missing or older than a day.
 */
export function googleAliasTarget(id: string): string | undefined {
	const entry = load()[id];
	if (!entry || Date.now() - Date.parse(entry.checkedAt) > MAX_AGE_MS) void refreshGoogleAlias(id);
	return entry?.target;
}
