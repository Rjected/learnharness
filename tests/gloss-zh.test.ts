/** The Chinese reading popup: pinyin + CC-CEDICT senses. Dictionary cases need a CC-CEDICT file:
 *  LH_TEST_CEDICT, else the one gloss.ts downloads into the data dir; they skip without it. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config.ts";
import { glossChinese as glossWith, markSyllable } from "../src/server/gloss-zh.ts";

describe("markSyllable", () => {
	it("places tone marks by the a/e, ou, last-vowel rules", () => {
		assert.equal(markSyllable("hao3"), "hǎo");
		assert.equal(markSyllable("dou1"), "dōu");
		assert.equal(markSyllable("gui4"), "guì");
		assert.equal(markSyllable("lu:4"), "lǜ");
		assert.equal(markSyllable("Zhong1"), "Zhōng");
		assert.equal(markSyllable("ma5"), "ma");
	});
});

const DICT = process.env.LH_TEST_CEDICT ?? path.join(PATHS.data, "dictionaries", "zh-cedict.txt");
const hasDict = fs.existsSync(DICT);
const glossChinese = (text: string) => glossWith(text, DICT);

describe("glossChinese", { skip: !hasDict && "no CC-CEDICT in the data dir" }, () => {
	const word = (text: string, w: string) => glossChinese(text).words.find((x) => x.text === w)!;

	it("splits by longest dictionary match and reads in context", () => {
		const g = glossChinese("你会写汉字吗？");
		assert.deepEqual(g.words.map((w) => w.text), ["你", "会", "写", "汉字", "吗", "？"]);
		assert.equal(g.reading, "Nǐ huì xiě hànzì ma?");
	});

	it("keeps only the senses that fit the reading", () => {
		assert.match(word("你会写汉字吗？", "吗").entries[0]!.defs[0]!, /question particle/);
		assert.equal(word("我的猫", "的").entries.length, 1);
	});

	it("takes CEDICT's neutral tones and pinyin apostrophes", () => {
		assert.equal(word("我的朋友", "朋友").reading, "péngyou");
		assert.equal(glossChinese("女儿").reading, "nǚ'ér");
	});

	it("glosses potential complements through the verb–result word", () => {
		const w = word("找得到我的朋友", "找得到");
		assert.equal(w.reading, "zhǎodedào");
		assert.match(w.entries[0]!.reading, /^can: 找到/);
		assert.equal(word("做得好", "得").reading, "de");
	});

	it("reads plain words over slang and degree words", () => {
		// 我去 is in CEDICT only as slang ("what the…!"); 得很 is "very" only at the end (好得很).
		const words = (text: string) => glossChinese(text).words.filter((w) => w.reading).map((w) => w.text);
		assert.deepEqual(words("明天我去中国。"), ["明天", "我", "去", "中国"]);
		assert.deepEqual(words("吃得很快"), ["吃", "得", "很", "快"]);
		assert.deepEqual(words("好得很。"), ["好", "得很"]);
	});

	it("capitalizes proper nouns and sentence starts", () => {
		assert.equal(glossChinese("明天我去中国。").reading, "Míngtiān wǒ qù Zhōngguó.");
		assert.equal(word("王先生", "王").reading, "wáng");
	});
});
