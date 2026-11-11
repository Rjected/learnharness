/**
 * Japanese for the reading popup: kana readings plus JMdict senses.
 *
 * Words are split by longest match against JMdict (EDRDG, JMdict_e; CC BY-SA 4.0; gloss.ts
 * downloads it), the way Yomitan does it: from each position, the longest run that is a headword either as written or
 * once its inflections are undone by the rule table below (食べさせられませんでした → 食べる).
 * Japanese has no spaces and no context-free reading for kanji, so the dictionary is both the
 * word splitter and the reader: a word reads as its entry does, re-inflected to the surface.
 *
 * buildJapaneseDict turns the JMdict XML into one compact file (its format is described there);
 * glossJapanese loads it lazily and keeps it in memory, keyed by path.
 */

import fs from "node:fs";
import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import type { Gloss, GlossEntry, GlossWord } from "../core/languages.ts";

// Readings are hiragana (katakana words as written); an inflected word's entry reading names where it
// came from: "食べる たべる · polite past" (dictionary form, its reading, inflection).

const FORMAT = "ja-gloss/1";
/** Longest surface tried from one position; long enough for 勉強させられませんでした and most set phrases. */
const MAX_WORD = 20;
const MAX_ENTRIES = 3;
/** Hits scoring this far below the best are dropped (see findHits). */
const CUTOFF = 25;
/** Score of a common word met as written (news1/ichi1/spec/gai1 is 40, less a little for inflection). */
const COMMON_SCORE = 20;

// ── Kana ─────────────────────────────────────────────────────────────────────

/** Katakana ァ–ヶ (and the ヽヾ iteration marks) sit 0x60 above their hiragana; ー and ヷ–ヺ have none and stay. */
export function toHiragana(s: string): string {
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		out += (c >= 0x30a1 && c <= 0x30f6) || c === 0x30fd || c === 0x30fe ? String.fromCodePoint(c - 0x60) : ch;
	}
	return out;
}

export function toKatakana(s: string): string {
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		out += (c >= 0x3041 && c <= 0x3096) || c === 0x309d || c === 0x309e ? String.fromCodePoint(c + 0x60) : ch;
	}
	return out;
}

/** U+3041–3096 and ゝゞ, U+30A1–30FA, ー and ヽヾ (U+30FC–30FE). */
const KANA_ONLY = /^[ぁ-ゖゝゞァ-ヺー-ヾ]+$/;
/** Only hiragana and katakana (ー included); ・ and full-width punctuation are not kana. */
export const isKana = (s: string) => KANA_ONLY.test(s);
/** Characters a word can be made of: kana and ー (not ・ U+30FB), kanji, and the kanji-like 々〆〇. */
const JAPANESE = /[ぁ-ゖゝ-ゟァ-ヺー-ヿ々-〇]|\p{Script=Han}/u;
/** Digits and kanji numerals, after which a counter reading is wanted (3時 じ). */
const NUMERAL = /[0-9０-９〇一二三四五六七八九十百千万何数]/;

// ── Deinflection ─────────────────────────────────────────────────────────────

/** Word classes as bit flags: what an inflected form can be read as, and what a dictionary sense is. */
const V1 = 1; // ichidan, and everything that conjugates like one (食べられる, 書ける, している)
const V5 = 2; // godan
const VK = 4; // 来る
const VS = 8; // する, and verbs that end in it (愛する)
const ADJ = 16; // i-adjectives, and ない/たい forms
const MASU = 32; // polite ます forms, which conjugate on their own
const IKU = 64; // 行く: godan, but 行って/行った
const ARU = 128; // なさる, くださる…: godan, but なさいます
const COP = 256; // です
const NA = 512; // na-adjectives, which take な before a noun
/** Nouns that take する (勉強): only ever reached through a する form. */
const VSN = 1024;

/** POS entity names (as JMdict spells them) → the classes the deinflector can arrive at. */
const POS_CLASS: Record<string, number> = {
	v1: V1, "v1-s": V1,
	v5u: V5, v5k: V5, v5g: V5, v5s: V5, v5t: V5, v5n: V5, v5b: V5, v5m: V5, v5r: V5, "v5r-i": V5, "v5u-s": V5,
	"v5k-s": V5 | IKU, v5aru: V5 | ARU,
	vk: VK, "vs-i": VS, "vs-s": VS, vs: VSN,
	"adj-i": ADJ, "adj-ix": ADJ, "adj-na": NA,
	cop: COP,
};

export interface Rule {
	/** Inflected ending, and the ending that replaces it. */
	from: string;
	to: string;
	/** The same pair in kana, to re-inflect a dictionary reading (来ます/来る → きます/くる). */
	kanaFrom: string;
	kanaTo: string;
	/** Class the inflected form belongs to (0: final forms, matched only as written), and the class it leaves. */
	of: number;
	gives: number;
	label: string;
	/** Imperatives and bare stems collide with everyday words (これ, それ), so they count only when nothing else fits. */
	weak: boolean;
}

const RULES: Rule[] = [];

function rule(from: string, to: string, of: number, gives: number, label: string, weak = false): void {
	RULES.push({ from, to, kanaFrom: from, kanaTo: to, of, gives, label, weak });
	// 来る's kanji reads differently by form (こない, きます, くれば), so each kana rule has a 来 twin
	// that re-reads through the kana one.
	if (gives === VK) RULES.push({ from: "来" + from.slice(1), to: "来" + to.slice(1), kanaFrom: from, kanaTo: to, of, gives, label, weak });
}

type Attach = [suffix: string, of: number, label: string];

/** What follows the negative stem: 書か-, 食べ-, し-, こ-. */
const AFTER_NEGATIVE: Attach[] = [
	["ない", ADJ, "negative"],
	["ないで", 0, "negative te-form"],
	["ず", 0, "negative"],
	["ずに", 0, "without"],
	["なければならない", ADJ, "must"],
	["なければなりません", 0, "must polite"],
	["なければいけない", ADJ, "must"],
	["なければいけません", 0, "must polite"],
	["なくてはならない", ADJ, "must"],
	["なくてはいけない", ADJ, "must"],
	["なきゃ", 0, "must"],
	["なくちゃ", 0, "must"],
];
/** What follows the continuative (masu) stem: 書き-, 食べ-, し-, き-. */
const AFTER_STEM: Attach[] = [
	["ます", MASU, "polite"],
	["たい", ADJ, "want"],
	["ながら", 0, "while"],
	["なさい", 0, "command"],
	["すぎる", V1, "too much"],
];
/** What follows the te-form, spelled after て; voiced stems (読んで, 泳いで) voice the first kana.
 *  Not ても: 見せてもらえません would read 見せても + ら…; て + the particle も says the same. */
const AFTER_TE: Attach[] = [
	["て", 0, "te-form"],
	["ている", V1, "progressive"],
	["てる", V1, "progressive"],
	["てしまう", V5, "completed"],
	["ちゃう", V5, "completed"],
	["ておく", V5, "in advance"],
	["とく", V5, "in advance"],
];
/** What follows the past stem, spelled after た. */
const AFTER_TA: Attach[] = [
	["た", 0, "past"],
	["たら", 0, "conditional"],
	["たり", 0, "-tari"],
];

const VOICED: Record<string, string> = { て: "で", た: "だ", ち: "じ", と: "ど" };
const voice = (s: string) => (VOICED[s[0]!] ?? s[0]!) + s.slice(1);

/** Te-form → its attachments: 書いて → 書いている, 読んで → 読んでいる (the stem's last kana says whether to voice). */
function teForms(te: string, dict: string, gives: number, list: Attach[]): void {
	const voiced = te.endsWith("で");
	const head = te.slice(0, -1);
	for (const [suffix, of, label] of list) rule(head + (voiced ? voice(suffix) : suffix), dict, of, gives, label);
}

function attach(stem: string, dict: string, gives: number, list: Attach[]): void {
	for (const [suffix, of, label] of list) rule(stem + suffix, dict, of, gives, label);
}

/** Godan rows: dictionary ending, then its a-, i-, e-, o-row kana and te-form. */
const GODAN: [string, string, string, string, string, string][] = [
	["う", "わ", "い", "え", "お", "って"],
	["く", "か", "き", "け", "こ", "いて"],
	["ぐ", "が", "ぎ", "げ", "ご", "いで"],
	["す", "さ", "し", "せ", "そ", "して"],
	["つ", "た", "ち", "て", "と", "って"],
	["ぬ", "な", "に", "ね", "の", "んで"],
	["ぶ", "ば", "び", "べ", "ぼ", "んで"],
	["む", "ま", "み", "め", "も", "んで"],
	["る", "ら", "り", "れ", "ろ", "って"],
];

for (const [u, a, i, e, o, te] of GODAN) {
	attach(a, u, V5, AFTER_NEGATIVE);
	attach(i, u, V5, AFTER_STEM);
	rule(i, u, 0, V5, "stem", true);
	teForms(te, u, V5, AFTER_TE);
	teForms(te, u, V5, AFTER_TA);
	rule(e + "ば", u, 0, V5, "conditional");
	rule(o + "う", u, 0, V5, "volitional");
	rule(e, u, 0, V5, "imperative", true);
	rule(e + "る", u, V1, V5, "potential");
	rule(a + "れる", u, V1, V5, "passive");
	rule(a + "せる", u, V1, V5, "causative");
	rule(a + "せられる", u, V1, V5, "causative passive");
	if (u !== "す") rule(a + "される", u, V1, V5, "causative passive");
}
teForms("って", "く", IKU, AFTER_TE);
teForms("って", "く", IKU, AFTER_TA);
attach("い", "る", ARU, AFTER_STEM);
rule("い", "る", 0, ARU, "imperative", true);

// Ichidan: the stem is the dictionary form minus る, so every ending attaches straight to it.
attach("", "る", V1, AFTER_NEGATIVE);
attach("", "る", V1, AFTER_STEM);
teForms("て", "る", V1, AFTER_TE);
teForms("て", "る", V1, AFTER_TA);
rule("れば", "る", 0, V1, "conditional");
rule("よう", "る", 0, V1, "volitional");
rule("ろ", "る", 0, V1, "imperative", true);
rule("よ", "る", 0, V1, "imperative", true);
rule("られる", "る", V1, V1, "passive/potential");
rule("れる", "る", V1, V1, "potential");
rule("させる", "る", V1, V1, "causative");
rule("させられる", "る", V1, V1, "causative passive");

// する: し- for most forms, but せず, and the potential is a different verb (できる).
attach("し", "する", VS, AFTER_NEGATIVE.filter(([s]) => !s.startsWith("ず")));
rule("せず", "する", 0, VS, "negative");
rule("せずに", "する", 0, VS, "without");
attach("し", "する", VS, AFTER_STEM);
teForms("して", "する", VS, AFTER_TE);
teForms("して", "する", VS, AFTER_TA);
rule("すれば", "する", 0, VS, "conditional");
rule("しよう", "する", 0, VS, "volitional");
rule("しろ", "する", 0, VS, "imperative", true);
rule("せよ", "する", 0, VS, "imperative", true);
rule("できる", "する", V1, VS, "potential");
rule("される", "する", V1, VS, "passive");
rule("させる", "する", V1, VS, "causative");
rule("させられる", "する", V1, VS, "causative passive");

// 来る: こ- / き- / く-, each with a 来 twin (see rule()).
attach("こ", "くる", VK, AFTER_NEGATIVE);
attach("き", "くる", VK, AFTER_STEM);
teForms("きて", "くる", VK, AFTER_TE);
teForms("きて", "くる", VK, AFTER_TA);
rule("くれば", "くる", 0, VK, "conditional");
rule("こよう", "くる", 0, VK, "volitional");
rule("こい", "くる", 0, VK, "imperative", true);
rule("こられる", "くる", V1, VK, "passive/potential");
rule("これる", "くる", V1, VK, "potential");
rule("こさせる", "くる", V1, VK, "causative");
rule("こさせられる", "くる", V1, VK, "causative passive");

// Polite ます forms conjugate on their own before handing back to the verb.
rule("ました", "ます", 0, MASU, "past");
rule("ません", "ます", 0, MASU, "negative");
rule("ませんでした", "ます", 0, MASU, "negative past");
rule("ましょう", "ます", 0, MASU, "volitional");
rule("まして", "ます", 0, MASU, "te-form");

// I-adjectives (and the ない/たい forms, which conjugate like them).
rule("く", "い", 0, ADJ, "adverb");
rule("くない", "い", ADJ, ADJ, "negative");
rule("かった", "い", 0, ADJ, "past");
rule("くて", "い", 0, ADJ, "te-form");
rule("ければ", "い", 0, ADJ, "conditional");
rule("かったら", "い", 0, ADJ, "conditional");
rule("かろう", "い", 0, ADJ, "presumptive");
rule("くありません", "い", 0, ADJ, "polite negative");
rule("くありませんでした", "い", 0, ADJ, "polite negative past");
rule("さ", "い", 0, ADJ, "noun");
rule("そう", "い", 0, ADJ, "looks");
rule("すぎる", "い", V1, ADJ, "too");

rule("でした", "です", 0, COP, "past");
// JMdict has no entry for the な of 静かな (only the な of "don't!"), so it stays with its adjective.
rule("な", "", 0, NA, "attributive");

/** Rules by the last character of their inflected ending, so a word only meets rules that can fit it. */
const RULES_BY_LAST = new Map<string, Rule[]>();
for (const r of RULES) {
	const last = r.from.slice(-1);
	const list = RULES_BY_LAST.get(last);
	if (list) list.push(r);
	else RULES_BY_LAST.set(last, [r]);
}

export interface Deinflection {
	/** Candidate dictionary form. */
	term: string;
	/** Classes it must be (0: the text as written, any class). */
	cls: number;
	/** Rules applied, outermost (the surface's ending) first. */
	rules: Rule[];
}

const MAX_DEPTH = 8;

/** Every way to read `word` as a dictionary form plus inflections, breadth-first, so the shortest
 *  chain to a form wins (食べさせられる: causative passive in one step, not causative + passive). */
export function deinflect(word: string): Deinflection[] {
	const out: Deinflection[] = [{ term: word, cls: 0, rules: [] }];
	const seen = new Set([`${word}:0`]);
	for (let n = 0; n < out.length; n++) {
		const cur = out[n]!;
		if (cur.rules.length >= MAX_DEPTH) continue;
		for (const r of RULES_BY_LAST.get(cur.term.slice(-1)) ?? []) {
			if (cur.cls && !(cur.cls & r.of)) continue;
			if (!cur.term.endsWith(r.from)) continue;
			// A weak rule is a guess about the text as written; nothing chains through it.
			if (cur.rules.some((x) => x.weak)) continue;
			const term = cur.term.slice(0, cur.term.length - r.from.length) + r.to;
			if (!term) continue;
			const key = `${term}:${r.gives}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ term, cls: r.gives, rules: [...cur.rules, r] });
		}
	}
	return out;
}

/** Labels innermost first, the way the forms stack: causative passive polite negative past. */
export function inflectionLabel(rules: Rule[]): string {
	return rules
		.map((r) => r.label)
		.reverse()
		.join(" ");
}

/** Put a dictionary reading back into the surface's inflection (たべる → たべました); null if it does not fit. */
export function reinflect(reading: string, rules: Rule[]): string | null {
	let s = reading;
	for (let i = rules.length - 1; i >= 0; i--) {
		const r = rules[i]!;
		if (!s.endsWith(r.kanaTo)) return null;
		s = s.slice(0, s.length - r.kanaTo.length) + r.kanaFrom;
	}
	return s;
}

// ── Compact dictionary ───────────────────────────────────────────────────────

/** One JMdict entry as stored, one JSON line each. Tag lists are space-separated entity names. */
interface Kanji {
	/** keb */
	t: string;
	/** ke_pri */
	p?: string;
	/** ke_inf */
	i?: string;
}
interface Reading {
	/** reb */
	t: string;
	/** re_pri */
	p?: string;
	/** re_inf */
	i?: string;
	/** re_restr: the only kanji forms this reading belongs to. */
	x?: string[];
	/** re_nokanji: not a true reading of the kanji. */
	n?: 1;
}
interface Sense {
	/** pos (carried forward from the previous sense when JMdict leaves it out) */
	p?: string;
	/** misc */
	m?: string;
	/** stagk / stagr: forms this sense is limited to. */
	k?: string[];
	r?: string[];
	/** gloss */
	g: string[];
}
interface Entry {
	/** ent_seq */
	q: number;
	k?: Kanji[];
	r: Reading[];
	s: Sense[];
}

const XML_ESCAPES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Text content: XML escapes decoded, inner tags (<pri>) dropped, and DTD entities (&v5r;) kept as their names. */
function xmlText(s: string): string {
	return s
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[\w-]+);/gi, (_, name: string) => {
			if (name[0] === "#") return String.fromCodePoint(name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
			return XML_ESCAPES[name] ?? name;
		})
		.trim();
}

const tagPatterns = new Map<string, RegExp>();
/** Contents of each <tag>…</tag> directly inside `xml` (JMdict never nests a tag inside itself). */
function children(xml: string, tag: string): string[] {
	let re = tagPatterns.get(tag);
	if (!re) tagPatterns.set(tag, (re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g")));
	return Array.from(xml.matchAll(re), (m) => m[1]!);
}
const texts = (xml: string, tag: string) => children(xml, tag).map(xmlText);
const tags = (xml: string, tag: string) => texts(xml, tag).join(" ") || undefined;
const list = (xml: string, tag: string) => {
	const all = texts(xml, tag);
	return all.length ? all : undefined;
};

function parseEntry(xml: string): Entry {
	const k = children(xml, "k_ele").map((x): Kanji => ({ t: texts(x, "keb")[0]!, p: tags(x, "ke_pri"), i: tags(x, "ke_inf") }));
	const r = children(xml, "r_ele").map(
		(x): Reading => ({ t: texts(x, "reb")[0]!, p: tags(x, "re_pri"), i: tags(x, "re_inf"), x: list(x, "re_restr"), n: /<re_nokanji\s*\/?>/.test(x) ? 1 : undefined }),
	);
	let pos: string | undefined;
	const s = children(xml, "sense").map((x): Sense => {
		pos = tags(x, "pos") ?? pos;
		return { p: pos, m: tags(x, "misc"), k: list(x, "stagk"), r: list(x, "stagr"), g: texts(x, "gloss") };
	});
	return { q: Number(texts(xml, "ent_seq")[0]), k: k.length ? k : undefined, r, s };
}

/** Open a file, gunzipping it when it starts with the gzip magic bytes. */
function openSource(file: string): NodeJS.ReadableStream {
	const fd = fs.openSync(file, "r");
	const magic = Buffer.alloc(2);
	fs.readSync(fd, magic, 0, 2, 0);
	fs.closeSync(fd);
	const raw = fs.createReadStream(file);
	return magic[0] === 0x1f && magic[1] === 0x8b ? raw.pipe(zlib.createGunzip()) : raw;
}

/** Header line width: the header is written last (it holds counts and offsets) over a blank line of this size. */
const HEADER_BYTES = 512;

/**
 * Turn JMdict_e(.gz) into the compact file glossJapanese loads. Async: the XML is streamed one
 * <entry> at a time and entries are written as they are parsed, so neither the 60 MB of XML nor
 * the output is ever held whole; only the headword index is.
 *
 * Output: a JSON header line (space-padded), one JSON line per entry, then one "key\tid,id" line
 * per headword (kanji forms as written, kana forms folded to hiragana). The header gives the byte
 * offsets of both sections, so the loader indexes the keys and leaves entries as bytes until one
 * is looked up.
 */
export async function buildJapaneseDict(sourceFile: string, outFile: string): Promise<void> {
	const tmp = `${outFile}.tmp`;
	const fd = fs.openSync(tmp, "w");
	let written = 0;
	let pending = "";
	const flush = () => {
		const buf = Buffer.from(pending);
		for (let at = 0; at < buf.length; ) at += fs.writeSync(fd, buf, at, buf.length - at, written + at);
		written += buf.length;
		pending = "";
	};
	const index = new Map<string, number[]>();
	let count = 0;
	const take = (xml: string) => {
		const entry = parseEntry(xml);
		const id = count++;
		pending += JSON.stringify(entry) + "\n";
		if (pending.length > 1 << 20) flush();
		for (const key of new Set([...(entry.k ?? []).map((k) => k.t), ...entry.r.map((r) => toHiragana(r.t))])) {
			const ids = index.get(key);
			if (ids) ids.push(id);
			else index.set(key, [id]);
		}
	};
	let done = false;
	try {
		pending = " ".repeat(HEADER_BYTES - 1) + "\n";
		flush();
		const decoder = new StringDecoder("utf8");
		let carry = "";
		for await (const chunk of openSource(sourceFile)) {
			carry += decoder.write(chunk as Buffer);
			const end = carry.lastIndexOf("</entry>");
			if (end < 0) continue;
			const complete = carry.slice(0, end + 8);
			carry = carry.slice(end + 8);
			for (const m of complete.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) take(m[1]!);
		}
		if (!count) throw new Error(`${sourceFile}: no JMdict entries found`);
		flush();
		const indexAt = written - HEADER_BYTES;
		const keys = [...index.keys()].sort();
		for (const key of keys) {
			pending += `${key}\t${index.get(key)!.join(",")}\n`;
			if (pending.length > 1 << 20) flush();
		}
		flush();
		const header = JSON.stringify({
			format: FORMAT,
			source: "JMdict_e (EDRDG, CC BY-SA 4.0)",
			created: new Date().toISOString(),
			entries: count,
			keys: keys.length,
			entriesAt: 0,
			indexAt,
		});
		const head = Buffer.from(header.padEnd(HEADER_BYTES - 1) + "\n");
		if (head.length !== HEADER_BYTES) throw new Error("header too long");
		fs.writeSync(fd, head, 0, head.length, 0);
		done = true;
	} finally {
		fs.closeSync(fd);
		if (!done) fs.rmSync(tmp, { force: true });
	}
	fs.renameSync(tmp, outFile);
}

interface Dict {
	buf: Buffer;
	/** Byte offset of each entry line, plus one past the last. */
	starts: Uint32Array;
	/** Headword → comma-separated entry ids, parsed on lookup. */
	keys: Map<string, string>;
	parsed: Map<number, Entry>;
}

const dicts = new Map<string, Dict>();

function loadDict(file: string): Dict {
	const cached = dicts.get(file);
	if (cached) return cached;
	const buf = fs.readFileSync(file);
	const nl = buf.indexOf(10);
	const head = JSON.parse(buf.toString("utf8", 0, nl)) as { format: string; entries: number; entriesAt: number; indexAt: number };
	if (head.format !== FORMAT) throw new Error(`${file}: not a ${FORMAT} file; rebuild it with buildJapaneseDict`);
	const body = nl + 1;
	const starts = new Uint32Array(head.entries + 1);
	let at = body + head.entriesAt;
	for (let i = 0; i < head.entries; i++) {
		starts[i] = at;
		at = buf.indexOf(10, at) + 1;
	}
	starts[head.entries] = at;
	const keys = new Map<string, string>();
	const text = buf.toString("utf8", body + head.indexAt);
	for (let pos = 0; pos < text.length; ) {
		const tab = text.indexOf("\t", pos);
		const end = text.indexOf("\n", tab);
		keys.set(text.slice(pos, tab), text.slice(tab + 1, end));
		pos = end + 1;
	}
	const dict = { buf, starts, keys, parsed: new Map<number, Entry>() };
	dicts.set(file, dict);
	return dict;
}

function entriesFor(d: Dict, key: string): [number, Entry][] {
	const ids = d.keys.get(key);
	if (!ids) return [];
	return ids.split(",").map((s) => {
		const id = Number(s);
		let e = d.parsed.get(id);
		if (!e) {
			// Parsed entries are small; the cap only keeps a long-running server from slowly parsing all 200k.
			if (d.parsed.size > 50_000) d.parsed.clear();
			e = JSON.parse(d.buf.toString("utf8", d.starts[id]!, d.starts[id + 1]! - 1)) as Entry;
			d.parsed.set(id, e);
		}
		return [id, e];
	});
}

// ── Matching and ranking ─────────────────────────────────────────────────────

const has = (list: string | undefined, tag: string) => !!list && ` ${list} `.includes(` ${tag} `);
const COMMON = ["news1", "ichi1", "spec1", "spec2", "gai1"];
const isCommon = (pri: string | undefined) => COMMON.some((t) => has(pri, t));
/** Kanji and kana forms that are rare, outdated, irregular or search-only. */
const ODD_FORM = /\b(rK|sK|oK|iK|ik|ok|rk|sk)\b/;
const SEARCH_ONLY = /\b(sK|sk)\b/;

/** Priority of a kanji/reading pair: JMdict tags both, and a reading's tags can come from another
 *  of its kanji (もと carries 元's news1, not 本's), so only tags on both count. */
function pairPriority(kanji: Kanji | undefined, reading: Reading): string {
	if (!kanji) return reading.p ?? "";
	if (!reading.p) return kanji.p ?? "";
	return (kanji.p ?? "").split(" ").filter((t) => has(reading.p, t)).join(" ");
}

/** Classes a sense's POS tags ("v5r vi") put it in; a deinflection fits a sense when they share one. */
export function posClass(pos: string): number {
	let cls = 0;
	for (const p of pos.split(" ")) cls |= POS_CLASS[p] ?? 0;
	return cls;
}
const senseClass = (s: Sense) => posClass(s.p ?? "");

/** news1/ichi1/spec/gai1 mark the common ~20k words; nfXX ranks the newspaper ones by 500s.
 *  Newspapers count kanji spellings, so for a word met in kana only common-or-not is trusted
 *  (いる: 要る has news1 nf07 from 要る in print, 居る only ichi1, yet kana いる is nearly always 居る). */
function priority(pri: string, coarse: boolean): number {
	let score = 0;
	for (const t of COMMON) if (has(pri, t)) score += score ? 5 : 40;
	if (!score && /\b(news2|ichi2|gai2)\b/.test(pri)) score = 15;
	if (coarse) return Math.min(score, 40);
	const nf = /\bnf(\d\d)\b/.exec(pri);
	if (nf) score += Math.max(0, 49 - Number(nf[1])) / 4;
	return score;
}

/** Nouns, counters and affixes: in kana they lose to a verb or particle spelled the same (して is する, not 仕手). */
const NOUNISH = /^(n|n-adv|n-t|n-suf|n-pref|n-pr|ctr|num|adj-no|suf|pref)$/;
const nounOnly = (senses: Sense[]) => senses.every((s) => (s.p ?? "n").split(" ").every((p) => NOUNISH.test(p)));

/** The reading a kanji form is read with: JMdict lists readings most usual first, and its priority
 *  tags follow newspaper counts of the kanji (昨日 さくじつ outscores きのう), so take the first common one. */
function readingFor(e: Entry, kanji: Kanji): Reading | undefined {
	const fits = e.r.filter((r) => !r.n && (!r.x || r.x.includes(kanji.t)));
	const plain = fits.filter((r) => !ODD_FORM.test(r.i ?? ""));
	return plain.find((r) => isCommon(r.p)) ?? plain[0] ?? fits[0] ?? e.r[0];
}

/** The kanji form to show for a word met in kana, if it is a normal spelling of that reading. */
function kanjiFor(e: Entry, reading: Reading): Kanji | undefined {
	if (reading.n) return undefined;
	const fits = (e.k ?? []).filter((k) => (!reading.x || reading.x.includes(k.t)) && !ODD_FORM.test(k.i ?? ""));
	return fits.find((k) => isCommon(k.p)) ?? fits[0];
}

interface Hit {
	id: number;
	/** Dictionary form as shown (食べる, 勉強する, いる) and its reading (hiragana unless met in katakana). */
	form: string;
	formReading: string;
	/** Reading of the text as written. */
	reading: string;
	label: string;
	senses: Sense[];
	score: number;
	weak: boolean;
	/** Met in kana spelled as the dictionary spells it (not ハム for はむ). */
	sameScript: boolean;
}

/** Reading of an inflected kanji word: the dictionary reading put back through the same rules
 *  (来ませんでした: くる → きませんでした), or, if the reading does not end as the rules expect,
 *  with the kana tail swapped (whatever surface and dictionary form share is read the same). */
function readSurface(surface: string, di: Deinflection, dictReading: string): string {
	const back = reinflect(dictReading, di.rules);
	if (back !== null) return toHiragana(back);
	let p = 0;
	while (p < surface.length && surface[p] === di.term[p]) p++;
	const tail = di.term.slice(p);
	return dictReading.endsWith(tail) ? dictReading.slice(0, dictReading.length - tail.length) + toHiragana(surface.slice(p)) : dictReading;
}

function findHits(d: Dict, surface: string): Hit[] {
	const kanaSurface = isKana(surface);
	const hits = new Map<number, Hit>();
	const tryTerm = (term: string, di: Deinflection, viaSuru: boolean) => {
		const kana = isKana(term);
		const key = kana ? toHiragana(term) : term;
		const need = viaSuru ? VSN : di.cls;
		for (const [id, e] of entriesFor(d, key)) {
			let kanji: Kanji | undefined;
			let reading: Reading | undefined;
			if (kana) {
				// Katakana may stand for a hiragana word (ワタシ), but hiragana is not a katakana word (がいる ≠ ガイル).
				const rs = e.r.filter((r) => (term === key ? r.t === term : toHiragana(r.t) === key));
				reading = rs.find((r) => r.t === term) ?? rs[0];
			} else {
				kanji = e.k?.find((k) => k.t === term);
				if (kanji) reading = readingFor(e, kanji);
			}
			if (!reading) continue;
			const senses = e.s.filter(
				(s) => (!s.k || !kanji || s.k.includes(kanji.t)) && (!s.r || s.r.includes(reading.t)) && (!need || senseClass(s) & need),
			);
			if (!senses.length) continue;
			const suru = viaSuru ? "する" : "";
			const uk = senses.some((s) => has(s.m, "uk"));
			const shownKanji = kana ? (uk ? undefined : kanjiFor(e, reading)) : kanji;
			const dictReading = kana ? reading.t + suru : toHiragana(reading.t + suru);
			const surfaceReading = kanaSurface ? surface : readSurface(surface, di, dictReading);
			let score = priority(pairPriority(kanji, reading), kana && !!e.k);
			if (kana && e.k && !uk && !e.k.every((k) => has(k.i, "sK"))) score -= 30; // normally written in kanji
			if (kana && e.k && nounOnly(senses)) score -= 20;
			const inf = `${kanji?.i ?? ""} ${reading.i ?? ""}`;
			if (SEARCH_ONLY.test(inf)) score -= 20;
			else if (ODD_FORM.test(inf)) score -= 5;
			// A kanji that heads one entry and is an alternative spelling in another reads as the first (本 ほん, not もと).
			if (kanji && kanji === e.k![0]) score += 5;
			// 行った/行って are far more often 行く than 行う, which newspaper counts favour.
			if (di.rules.some((r) => r.gives === IKU)) score += 20;
			if (senses.every((s) => /\b(arch|obs|rare)\b/.test(s.m ?? ""))) score -= 15;
			score += di.rules.length ? -di.rules.length : 5; // as written beats undone inflections
			const hit: Hit = {
				id,
				form: shownKanji ? shownKanji.t + suru : dictReading,
				formReading: dictReading,
				reading: surfaceReading,
				label: inflectionLabel(di.rules),
				senses,
				score,
				weak: di.rules.some((r) => r.weak),
				sameScript: !kana || reading.t === term,
			};
			const prev = hits.get(id);
			if (!prev || prev.score < hit.score) hits.set(id, hit);
		}
	};
	for (const di of deinflect(surface)) {
		tryTerm(di.term, di, false);
		if (di.term.length > 2 && di.term.endsWith("する") && (!di.cls || di.cls & VS)) tryTerm(di.term.slice(0, -2), di, true);
	}
	let all = [...hits.values()];
	// A katakana word written as such beats a hiragana word that happens to read the same (ハム, not 食む).
	if (all.some((h) => h.sameScript)) all = all.filter((h) => h.sameScript);
	if (all.some((h) => !h.weak)) all = all.filter((h) => !h.weak);
	// Ties go to the entry with more senses, usually the everyday word (居る over 要る).
	all.sort((a, b) => b.score - a.score || b.senses.length - a.senses.length || a.id - b.id);
	// Far below the best is noise in a sentence popup (は the particle, not 葉 or 歯).
	return all.filter((h) => h.score >= all[0]!.score - CUTOFF);
}

/** How well a word fits right after a numeral: counter, suffix, noun, anything else. */
function counterRank(h: Hit): number {
	const pos = new Set(h.senses.flatMap((s) => s.p?.split(" ") ?? []));
	return pos.has("ctr") ? 0 : pos.has("suf") || pos.has("n-suf") ? 1 : pos.has("n") ? 2 : 3;
}

const clip = (d: string) => (d.length > 110 ? `${d.slice(0, 107).trimEnd()}…` : d);

/** Hits → popup entries: one per dictionary form, archaic senses dropped when others remain, 3 at most (every sense: the popup keeps the rest behind a tap). */
function toEntries(hits: Hit[], kanaSurface: boolean): GlossEntry[] {
	const merged: { key: string; reading: string; defs: string[] }[] = [];
	for (const h of hits) {
		const shown = h.form === h.formReading ? h.formReading : `${h.form} ${h.formReading}`;
		const reading = h.label ? `${shown} · ${h.label}` : kanaSurface ? shown : h.formReading;
		const live = h.senses.filter((s) => !/\b(arch|obs)\b/.test(s.m ?? ""));
		const defs = (live.length ? live : h.senses).map((s) => clip(s.g.join("; "))).filter(Boolean);
		const key = `${h.form}|${h.formReading}|${h.label}`;
		const same = merged.find((m) => m.key === key);
		if (same) same.defs.push(...defs.filter((x) => !same.defs.includes(x)));
		else merged.push({ key, reading, defs: [...new Set(defs)] });
	}
	return merged.slice(0, MAX_ENTRIES).map((m) => ({ reading: m.reading, defs: m.defs }));
}

// ── Sentence ─────────────────────────────────────────────────────────────────

const PUNCT: Record<string, string> = {
	"。": ".", "、": ",", "，": ",", "．": ".", "？": "?", "！": "!", "：": ":", "；": ";",
	"「": "“", "」": "”", "『": "“", "』": "”", "（": "(", "）": ")", "〜": "~", "～": "~", "・": "·",
};

/** Word readings joined by spaces, Japanese punctuation in its ASCII-ish form, hugging the word before it. */
function sentenceReading(words: GlossWord[]): string {
	return words
		.map((w) => w.reading || Array.from(w.text.trim(), (c) => PUNCT[c] ?? c).join(""))
		.filter(Boolean)
		.join(" ")
		.replace(/ ([,.?!:;”)~…])/g, "$1")
		.replace(/([“(]) /g, "$1");
}

export function glossJapanese(text: string, dictFile: string): Gloss {
	const d = loadDict(dictFile);
	const chars = Array.from(text);
	const memo = new Map<string, Hit[]>();
	const hitsFor = (i: number, len: number) => {
		const s = chars.slice(i, i + len).join("");
		let hits = memo.get(s);
		if (!hits) memo.set(s, (hits = findHits(d, s)));
		return hits;
	};
	const runFrom = (i: number) => {
		let j = i;
		while (j < chars.length && j - i < MAX_WORD && JAPANESE.test(chars[j]!)) j++;
		return j - i;
	};
	/** Whether a common word starts at j. */
	const startsCommon = (j: number) => {
		for (let len = runFrom(j); len >= 1; len--) if ((hitsFor(j, len)[0]?.score ?? 0) >= COMMON_SCORE) return true;
		return false;
	};
	/** Longest match at i, with three exceptions that give way to a shorter one (unless nothing shorter fits):
	 *  after a numeral only nouns and counters fit, counters first (3時に: 時 じ, not 時に "by the way";
	 *  3時間 stays whole; 2人 にん, not じん);
	 *  a greeting run into more words is a word plus は (今日は晴れ is 今日 + は, not こんにちは); and a
	 *  kana spelling of a kanji word (scored below 0) must be followed by a common word, so it cannot
	 *  swallow a particle and strand the rest (猫がいる: が + いる, not 害 + る). */
	const matchAt = (i: number) => {
		let fallback: { len: number; hits: Hit[] } | undefined;
		if (NUMERAL.test(chars[i - 1] ?? "")) {
			for (let len = runFrom(i); len >= 1; len--) {
				const hits = hitsFor(i, len);
				if (hits.some((h) => counterRank(h) < 3)) return { len, hits: [...hits].sort((a, b) => counterRank(a) - counterRank(b)) };
			}
		}
		for (let len = runFrom(i); len >= 1; len--) {
			const hits = hitsFor(i, len);
			if (!hits.length) continue;
			const more = len > 1 && JAPANESE.test(chars[i + len] ?? "");
			const greeting = hits.every((h) => h.senses.every((s) => s.p === "int"));
			if (more && (greeting || (hits[0]!.score < 0 && !startsCommon(i + len)))) fallback ??= { len, hits };
			else return { len, hits };
		}
		return fallback;
	};
	const words: GlossWord[] = [];
	let i = 0;
	while (i < chars.length) {
		if (!JAPANESE.test(chars[i]!)) {
			let j = i;
			while (j < chars.length && !JAPANESE.test(chars[j]!)) j++;
			words.push({ text: chars.slice(i, j).join(""), reading: "", entries: [] });
			i = j;
			continue;
		}
		const found = matchAt(i);
		const len = found?.len ?? 1;
		const word = chars.slice(i, i + len).join("");
		if (!found) words.push({ text: word, reading: isKana(word) ? word : "", entries: [] });
		else words.push({ text: word, reading: found.hits[0]!.reading, entries: toEntries(found.hits, isKana(word)) });
		i += len;
	}
	return { reading: sentenceReading(words), words };
}
