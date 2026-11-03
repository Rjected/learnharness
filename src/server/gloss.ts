/**
 * The reading popup's server half: GET /api/language/gloss?text=… gives the
 * run's reading plus each word's dictionary senses, in the studied language.
 *
 * Dictionaries are downloaded the first time a popup opens, and only for the
 * language being studied, into data/dictionaries/: CC-CEDICT for Chinese
 * (MDBG), JMdict for Japanese (EDRDG). Both are CC BY-SA 4.0.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PATHS } from "../../config.ts";
import type { Gloss, StudyLanguage } from "../core/languages.ts";
import { glossChinese } from "./gloss-zh.ts";
import { buildJapaneseDict, glossJapanese } from "./gloss-ja.ts";
import { studyProfile } from "./language.ts";

const DICT_DIR = path.join(PATHS.data, "dictionaries");
const MAX_CHARS = 200;

interface Dictionary {
	name: string;
	credit: string;
	/** The file glossing reads, under data/dictionaries/. */
	file: string;
	/** The gzip download it is built from. */
	url: string;
	build(gzFile: string, outFile: string): void | Promise<void>;
	gloss(text: string, dictFile: string): Gloss;
}

const DICTIONARIES: Record<StudyLanguage, Dictionary> = {
	zh: {
		name: "CC-CEDICT",
		credit: "CC-CEDICT · CC BY-SA 4.0",
		file: "zh-cedict.txt",
		url: "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz",
		build: (gz, out) => fs.writeFileSync(out, zlib.gunzipSync(fs.readFileSync(gz))),
		gloss: glossChinese,
	},
	ja: {
		name: "JMdict",
		credit: "JMdict © EDRDG · CC BY-SA 4.0",
		file: "ja-jmdict.txt",
		url: "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz",
		build: buildJapaneseDict,
		gloss: glossJapanese,
	},
};

const downloads = new Map<StudyLanguage, Promise<string>>();

/** The dictionary file, downloading and building it first if this is its first use. One download at a time. */
function ensureDictionary(lang: StudyLanguage): Promise<string> {
	const dict = DICTIONARIES[lang];
	const out = path.join(DICT_DIR, dict.file);
	if (fs.existsSync(out)) return Promise.resolve(out);
	let pending = downloads.get(lang);
	if (!pending) {
		pending = (async () => {
			const res = await fetch(dict.url, { signal: AbortSignal.timeout(180_000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			fs.mkdirSync(DICT_DIR, { recursive: true });
			const gz = `${out}.download.gz`;
			fs.writeFileSync(gz, Buffer.from(await res.arrayBuffer()));
			try {
				await dict.build(gz, `${out}.tmp`);
				fs.renameSync(`${out}.tmp`, out); // a half-built file never counts as installed
			} finally {
				fs.rmSync(gz, { force: true });
			}
			return out;
		})().finally(() => downloads.delete(lang));
		downloads.set(lang, pending);
	}
	return pending;
}

const cache = new Map<string, Gloss>();

export async function glossResponse(params: URLSearchParams): Promise<Response> {
	const text = (params.get("text") ?? "").trim();
	if (!text || Array.from(text).length > MAX_CHARS) {
		return Response.json({ error: `text must be 1–${MAX_CHARS} characters` }, { status: 400 });
	}
	const lang = studyProfile()?.id;
	if (!lang) return Response.json({ error: "No language is being studied (Settings → Agent → Studying)." }, { status: 404 });
	const dict = DICTIONARIES[lang];
	let file: string;
	try {
		file = await ensureDictionary(lang);
	} catch (err) {
		return Response.json({ error: `Couldn't download ${dict.name} (${err instanceof Error ? err.message : String(err)}). Try again when online.` }, { status: 503 });
	}
	const key = `${lang}\u0000${text}`;
	let gloss = cache.get(key);
	if (!gloss) {
		gloss = { ...dict.gloss(text, file), credit: dict.credit };
		if (cache.size > 2000) cache.clear();
		cache.set(key, gloss);
	}
	return Response.json(gloss, { headers: { "Cache-Control": "no-store" } });
}
