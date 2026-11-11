/**
 * Chinese for the reading popup: pinyin plus CC-CEDICT senses.
 *
 * Words are split by longest match against CC-CEDICT (the MDBG export,
 * CC BY-SA 4.0; gloss.ts downloads it), the way Yomitan does it. Readings
 * come from pinyin-pro over the whole run, so polyphones follow context
 * (行 xíng vs 银行 yínháng) and 不/一 sandhi is spoken; CEDICT entries
 * whose reading matches are listed first.
 */

import fs from "node:fs";
import { pinyin } from "pinyin-pro";
import type { Gloss, GlossEntry, GlossWord } from "../core/languages.ts";

const MAX_WORD = 8;
const HAN = /\p{Script=Han}/u;

const dicts = new Map<string, Map<string, GlossEntry[]>>();

const TONE_MARKS: Record<string, string> = {
	a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", ü: "ǖǘǚǜ",
	A: "ĀÁǍÀ", E: "ĒÉĚÈ", O: "ŌÓǑÒ",
};

/** "lu:4" → "lǜ", "Zhong1" → "Zhōng"; neutral tone 5 drops the number. */
export function markSyllable(syl: string): string {
	const m = /^([a-zA-Zü:]+)([1-5])$/.exec(syl);
	if (!m) return syl.replace(/u:/g, "ü");
	const base = m[1]!.replace(/u:/g, "ü").replace(/U:/g, "Ü");
	const tone = Number(m[2]);
	if (tone === 5) return base;
	// a or e takes the mark; in "ou" the o does; otherwise the last vowel.
	const lower = base.toLowerCase();
	let at = lower.search(/[ae]/);
	if (at < 0) at = lower.indexOf("ou");
	if (at < 0) {
		for (let i = lower.length - 1; i >= 0; i--) if ("iouü".includes(lower[i]!)) { at = i; break; }
	}
	if (at < 0) return base;
	const ch = base[at]!;
	const marks = TONE_MARKS[ch] ?? TONE_MARKS[ch.toLowerCase()];
	return marks ? base.slice(0, at) + marks[tone - 1] + base.slice(at + 1) : base;
}

function markPinyin(numbered: string): string {
	return numbered.split(" ").map(markSyllable).join(" ");
}

function loadDict(file: string): Map<string, GlossEntry[]> {
	const cached = dicts.get(file);
	if (cached) return cached;
	const map = new Map<string, GlossEntry[]>();
	const add = (key: string, entry: GlossEntry) => {
		const list = map.get(key);
		if (list) list.push(entry);
		else map.set(key, [entry]);
	};
	const text = fs.readFileSync(file, "utf8");
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("#")) continue;
		const m = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line);
		if (!m) continue;
		const [, trad, simp, reading, defs] = m;
		// Cross-references inside definitions carry numbered readings too: 您[nin2] → 您[nín].
		const entry = {
			reading: markPinyin(reading!),
			defs: defs!.split("/").filter(Boolean).map((def) => def.replace(/\[([^\]]+)\]/g, (_, r: string) => `[${markPinyin(r)}]`)),
		};
		add(simp!, entry);
		if (trad !== simp) add(trad!, entry);
	}
	dicts.set(file, map);
	return map;
}

/** A syllable without its tone mark, for lining readings up (ü kept apart from u is not needed here). */
const bare = (syl: string) => syl.normalize("NFD").replace(/\p{M}/gu, "").replace(/ü/g, "u").toLowerCase();
/** The tone mark of a syllable, or "" for neutral. */
const toneOf = (syl: string) => syl.normalize("NFD").match(/[\u0304\u0301\u030C\u0300]/)?.[0] ?? "";

/** Syllables join into one word; one starting with a/e/o after another takes an apostrophe (nǚ'ér). */
const joinSyllables = (syls: string[]) => syls.reduce((acc, syl) => acc + (acc && /^[aeoāáǎàēéěèōóǒò]/i.test(syl) ? "'" : "") + syl, "");

/** Same syllables and tones. A neutral dictionary syllable fits any spoken tone (pinyin-pro over-marks
 *  them), and 不/一 fit either tone since sandhi moves them (不是 bú shì vs CEDICT bù shì). */
function fits(entryPinyin: string, syls: string[]): boolean {
	const ds = entryPinyin.split(" ");
	return ds.length === syls.length && ds.every((d, k) => {
		const s = syls[k]!;
		return bare(d) === bare(s) && (!toneOf(d) || toneOf(d) === toneOf(s) || ((bare(s) === "bu" || bare(s) === "yi") && !!toneOf(s)));
	});
}

/** Variant / surname / classifier-only entries are noise next to a real sense. */
function rank(entries: GlossEntry[], syls: string[]): GlossEntry[] {
	const noise = (e: GlossEntry) => e.defs.every((d) => /^(surname |(old )?variant of |see |used in |CL:)/.test(d));
	const score = (e: GlossEntry) => (fits(e.reading, syls) ? 0 : 2) + (noise(e) ? 1 : 0);
	// Same reading listed twice (a simplified form shared by two traditional ones): one entry.
	const merged: GlossEntry[] = [];
	for (const e of [...entries].sort((a, b) => score(a) - score(b))) {
		const same = merged.find((m) => m.reading === e.reading);
		if (same) same.defs = [...same.defs, ...e.defs.filter((d) => !same.defs.includes(d))];
		else merged.push({ ...e, defs: [...e.defs] });
	}
	// When the context reading fits, its senses are the ones that matter (的 de, not the taxi 的 dī;
	// 东西 dōngxī keeps "thing", dōng xi, since a neutral dictionary syllable fits any tone).
	const matching = merged.filter((e) => fits(e.reading, syls));
	const clip = (d: string) => (d.length > 110 ? `${d.slice(0, 107).trimEnd()}…` : d);
	// Every sense goes out: the popup shows the first few and keeps the rest behind a tap.
	return (matching.length ? matching : merged).slice(0, 3).map((e) => ({ ...e, defs: e.defs.map(clip) }));
}

/** pinyin-pro's contextual syllables, but CEDICT's neutral tones (朋友 péngyou) where they otherwise agree. */
function wordSyllables(syls: string[], entries: GlossEntry[]): string[] {
	const ds = entries.map((e) => e.reading.split(" ")).find((d) => d.length === syls.length && d.every((x, k) => bare(x) === bare(syls[k]!)));
	return ds ? syls.map((syl, k) => (toneOf(ds[k]!) ? syl : ds[k]!.toLowerCase())) : syls;
}

/** A word known only as slang or vulgarity (我去 "what the…!") is rarely what a sentence means;
 *  the plain split (我 + 去, "I go") is read instead. */
const slangOnly = (entries: GlossEntry[]) =>
	entries.every((e) => e.defs.every((d) => /^\((Internet )?slang|^\(vulgar/.test(d)));

const DEGREE_DE = new Set(["得很", "得多"]);

/** Potential complements: 找得到 / 听不懂 are verb + 得/不 + result, glossed via the verb–result word (找到). */
const POTENTIAL = new Set(["得", "不"]);

export function glossChinese(text: string, dictFile: string): Gloss {
	const d = loadDict(dictFile);
	const chars = Array.from(text);
	// One reading per character, in sentence context.
	const readings = pinyin(text, { type: "all", toneSandhi: true }).map((r) => (r.isZh ? r.pinyin : ""));
	const words: GlossWord[] = [];
	let i = 0;
	while (i < chars.length) {
		if (!HAN.test(chars[i]!)) {
			let j = i;
			while (j < chars.length && !HAN.test(chars[j]!)) j++;
			words.push({ text: chars.slice(i, j).join(""), reading: "", entries: [] });
			i = j;
			continue;
		}
		let len = Math.min(MAX_WORD, chars.length - i);
		const usable = (n: number) => {
			const word = chars.slice(i, i + n).join("");
			const entries = d.get(word);
			// 好得很 ends on the degree word 得很; in 吃得很快 the 得 is the complement marker and 很快 follows.
			if (DEGREE_DE.has(word) && i > 0 && HAN.test(chars[i - 1]!) && HAN.test(chars[i + n] ?? "")) return false;
			return !!entries && !slangOnly(entries);
		};
		while (len > 1 && !usable(len)) len--;
		// A dictionary word wins; otherwise a single verb followed by 得/不 + a result it pairs with.
		const vr = chars[i]! + (chars[i + 2] ?? "");
		if (len === 1 && POTENTIAL.has(chars[i + 1] ?? "") && HAN.test(chars[i + 2] ?? "") && d.has(vr)) {
			const base = rank(d.get(vr)!, [readings[i]!, readings[i + 2]!])[0]!;
			const can = chars[i + 1] === "得";
			const syls = [readings[i]!, can ? "de" : "bu", readings[i + 2]!];
			words.push({
				text: chars.slice(i, i + 3).join(""),
				reading: joinSyllables(syls),
				entries: [{ reading: `${can ? "can" : "can't"}: ${vr} ${base.reading}`, defs: base.defs }],
			});
			i += 3;
			continue;
		}
		const word = chars.slice(i, i + len).join("");
		const entries = d.get(word) ?? [];
		const syls = wordSyllables(readings.slice(i, i + len), entries);
		// A lone 得 right after another character is the complement marker (做得好 zuò de hǎo), not dé.
		if (word === "得" && i > 0 && HAN.test(chars[i - 1]!) && syls[0] === "dé") syls[0] = "de";
		const ranked = rank(entries, syls);
		// Proper nouns are capitalized when that is the reading meant (中国 Zhōngguó; 王 wáng, king, not Wáng).
		if (/^\p{Lu}/u.test(ranked[0]?.reading ?? "") && syls[0]) syls[0] = syls[0][0]!.toUpperCase() + syls[0].slice(1);
		words.push({ text: word, reading: joinSyllables(syls), entries: ranked });
		i += len;
	}
	const sentence = words
		.map((w) => w.reading || w.text.trim().replace(/[，、]/g, ",").replace(/。/g, ".").replace(/？/g, "?").replace(/！/g, "!").replace(/：/g, ":").replace(/；/g, ";"))
		.filter(Boolean)
		.join(" ")
		.replace(/ ([,.?!:;])/g, "$1");
	// Full sentences start with a capital, as written pinyin does (Míngtiān wǒ qù Zhōngguó.); a bare word stays lowercase.
	const pinyinText = /[.?!]$/.test(sentence) ? sentence.replace(/(^|[.?!] )(\p{Ll})/gu, (_, at: string, c: string) => at + c.toUpperCase()) : sentence;
	return { reading: pinyinText, words };
}
