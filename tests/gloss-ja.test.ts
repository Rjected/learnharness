/** The Japanese reading popup: kana readings + JMdict senses, with deinflection. Dictionary cases need a built
 *  JMdict file: LH_TEST_JMDICT, else the one gloss.ts downloads into the data dir; they skip without it. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config.ts";
import { deinflect, glossJapanese, inflectionLabel, isKana, posClass, reinflect, toHiragana, toKatakana } from "../src/server/gloss-ja.ts";

const DICT = process.env.LH_TEST_JMDICT ?? path.join(PATHS.data, "dictionaries", "ja-jmdict.txt");

describe("kana", () => {
	it("folds katakana to hiragana and back, leaving ー and other text alone", () => {
		assert.equal(toHiragana("コーヒー"), "こーひー");
		assert.equal(toHiragana("ヴァイオリンとケーキ"), "ゔぁいおりんとけーき");
		assert.equal(toHiragana("食べマス!"), "食べます!");
		assert.equal(toKatakana("ひらがなー"), "ヒラガナー");
		assert.equal(toKatakana("ゔ"), "ヴ");
	});

	it("knows kana from kanji and punctuation", () => {
		assert.ok(isKana("たべる"));
		assert.ok(isKana("コーヒー"));
		assert.ok(!isKana("食べる"));
		assert.ok(!isKana("コーヒー・ショップ"));
		assert.ok(!isKana("か？"));
	});
});

describe("deinflect", () => {
	/** Label of the way `word` reaches dictionary form `term` as part of speech `pos`, the way a lookup asks; undefined if none. */
	const via = (word: string, term: string, pos: string) => {
		const d = deinflect(word).find((x) => x.term === term && (!x.cls || x.cls & posClass(pos)));
		return d && inflectionLabel(d.rules);
	};

	it("undoes polite forms", () => {
		assert.equal(via("食べます", "食べる", "v1"), "polite");
		assert.equal(via("食べました", "食べる", "v1"), "polite past");
		assert.equal(via("食べません", "食べる", "v1"), "polite negative");
		assert.equal(via("食べませんでした", "食べる", "v1"), "polite negative past");
		assert.equal(via("食べましょう", "食べる", "v1"), "polite volitional");
		assert.equal(via("飲みます", "飲む", "v5m"), "polite");
		assert.equal(via("なさいます", "なさる", "v5aru"), "polite");
	});

	it("undoes past, te, negative, want, conditional and volitional forms", () => {
		assert.equal(via("食べた", "食べる", "v1"), "past");
		assert.equal(via("食べて", "食べる", "v1"), "te-form");
		assert.equal(via("食べない", "食べる", "v1"), "negative");
		assert.equal(via("食べなかった", "食べる", "v1"), "negative past");
		assert.equal(via("食べなくて", "食べる", "v1"), "negative te-form");
		assert.equal(via("食べたい", "食べる", "v1"), "want");
		assert.equal(via("食べたかった", "食べる", "v1"), "want past");
		assert.equal(via("食べたくない", "食べる", "v1"), "want negative");
		assert.equal(via("食べれば", "食べる", "v1"), "conditional");
		assert.equal(via("食べたら", "食べる", "v1"), "conditional");
		assert.equal(via("食べよう", "食べる", "v1"), "volitional");
		assert.equal(via("書こう", "書く", "v5k"), "volitional");
		assert.equal(via("書けば", "書く", "v5k"), "conditional");
		assert.equal(via("書かない", "書く", "v5k"), "negative");
		assert.equal(via("行かなければなりません", "行く", "v5k-s"), "must polite");
	});

	it("undoes the progressive", () => {
		assert.equal(via("食べている", "食べる", "v1"), "progressive");
		assert.equal(via("食べてる", "食べる", "v1"), "progressive");
		assert.equal(via("食べていた", "食べる", "v1"), "progressive past");
		assert.equal(via("食べています", "食べる", "v1"), "progressive polite");
		assert.equal(via("読んでいる", "読む", "v5m"), "progressive");
	});

	it("undoes potential, passive and causative, and chains them", () => {
		assert.equal(via("書ける", "書く", "v5k"), "potential");
		assert.equal(via("書かれる", "書く", "v5k"), "passive");
		assert.equal(via("書かせる", "書く", "v5k"), "causative");
		assert.equal(via("書かせられる", "書く", "v5k"), "causative passive");
		assert.equal(via("食べられる", "食べる", "v1"), "passive/potential");
		assert.equal(via("食べさせる", "食べる", "v1"), "causative");
		assert.equal(via("食べさせられる", "食べる", "v1"), "causative passive");
		assert.equal(via("食べさせられませんでした", "食べる", "v1"), "causative passive polite negative past");
	});

	it("follows godan sound changes in te and past forms", () => {
		assert.equal(via("書いた", "書く", "v5k"), "past");
		assert.equal(via("泳いだ", "泳ぐ", "v5g"), "past");
		assert.equal(via("読んだ", "読む", "v5m"), "past");
		assert.equal(via("死んだ", "死ぬ", "v5n"), "past");
		assert.equal(via("遊んだ", "遊ぶ", "v5b"), "past");
		assert.equal(via("話した", "話す", "v5s"), "past");
		assert.equal(via("待った", "待つ", "v5t"), "past");
		assert.equal(via("買った", "買う", "v5u"), "past");
		assert.equal(via("帰った", "帰る", "v5r"), "past");
		assert.equal(via("書いて", "書く", "v5k"), "te-form");
		assert.equal(via("泳いで", "泳ぐ", "v5g"), "te-form");
		assert.equal(via("読んで", "読む", "v5m"), "te-form");
		// 行く is the one く verb with って/った; any other く verb cannot use them.
		assert.equal(via("行った", "行く", "v5k-s"), "past");
		assert.equal(via("行って", "行く", "v5k-s"), "te-form");
		assert.equal(via("書った", "書く", "v5k"), undefined);
	});

	it("handles する and 来る", () => {
		assert.equal(via("します", "する", "vs-i"), "polite");
		assert.equal(via("しない", "する", "vs-i"), "negative");
		assert.equal(via("した", "する", "vs-i"), "past");
		assert.equal(via("して", "する", "vs-i"), "te-form");
		assert.equal(via("勉強させられた", "勉強する", "vs-i"), "causative passive past");
		assert.equal(via("勉強しています", "勉強する", "vs-i"), "progressive polite");
		assert.equal(via("来ませんでした", "来る", "vk"), "polite negative past");
		assert.equal(via("来ない", "来る", "vk"), "negative");
		assert.equal(via("こない", "くる", "vk"), "negative");
		assert.equal(via("来た", "来る", "vk"), "past");
		assert.equal(via("きて", "くる", "vk"), "te-form");
	});

	it("handles i-adjectives", () => {
		assert.equal(via("新しかった", "新しい", "adj-i"), "past");
		assert.equal(via("新しく", "新しい", "adj-i"), "adverb");
		assert.equal(via("新しくない", "新しい", "adj-i"), "negative");
		assert.equal(via("新しくなかった", "新しい", "adj-i"), "negative past");
		assert.equal(via("新しくて", "新しい", "adj-i"), "te-form");
		assert.equal(via("新しければ", "新しい", "adj-i"), "conditional");
		assert.equal(via("新しさ", "新しい", "adj-i"), "noun");
		assert.equal(via("よかった", "よい", "adj-ix"), "past");
	});

	it("only lets a form through to the POS that makes it", () => {
		// 食べた is ichidan past: as godan or adjective it reaches nothing.
		assert.equal(via("食べた", "食べる", "v5r"), undefined);
		assert.equal(via("食べた", "食べる", "adj-i"), undefined);
		// 帰った is godan る past, not ichidan.
		assert.equal(via("帰った", "帰る", "v1"), undefined);
		// 新しかった is an adjective, not a verb.
		assert.equal(via("新しかった", "新しい", "v1"), undefined);
		// A final form is not inflected again: no 食べたた.
		assert.equal(via("食べたた", "食べる", "v1"), undefined);
		// する forms reach nouns only through する (勉強する), never as the bare noun with a verb class.
		assert.equal(via("勉強した", "勉強", "vs"), undefined);
	});

	it("re-inflects a dictionary reading to the surface", () => {
		const re = (word: string, term: string, pos: string, reading: string) =>
			reinflect(reading, deinflect(word).find((x) => x.term === term && x.cls & posClass(pos))!.rules);
		assert.equal(re("食べました", "食べる", "v1", "たべる"), "たべました");
		assert.equal(re("来ませんでした", "来る", "vk", "くる"), "きませんでした");
		assert.equal(re("来ない", "来る", "vk", "くる"), "こない");
		assert.equal(re("来れば", "来る", "vk", "くる"), "くれば");
		assert.equal(re("行った", "行く", "v5k-s", "いく"), "いった");
		assert.equal(re("書いた", "書く", "v5k", "かく"), "かいた");
	});
});

const hasDict = fs.existsSync(DICT);

describe("glossJapanese", { skip: !hasDict && `no built dictionary at ${DICT}` }, () => {
	const gloss = (text: string) => glossJapanese(text, DICT);
	const split = (text: string) => gloss(text).words.map((w) => w.text);
	const word = (text: string, w: string) => gloss(text).words.find((x) => x.text === w)!;

	it("splits and reads plain sentences", () => {
		assert.deepEqual(split("私は学生です。"), ["私", "は", "学生", "です", "。"]);
		assert.equal(gloss("私は学生です。").reading, "わたし は がくせい です.");
		assert.deepEqual(split("昨日、友達と映画を見ました。"), ["昨日", "、", "友達", "と", "映画", "を", "見ました", "。"]);
		assert.equal(gloss("昨日、友達と映画を見ました。").reading, "きのう, ともだち と えいが を みました.");
	});

	it("covers the input, with non-Japanese text as bare words", () => {
		const g = gloss("私はTomです！");
		assert.deepEqual(g.words.map((w) => w.text), ["私", "は", "Tom", "です", "！"]);
		assert.deepEqual(g.words[2], { text: "Tom", reading: "", entries: [] });
		assert.equal(g.reading, "わたし は Tom です!");
		assert.equal(gloss("コーヒーを飲みますか？").reading, "コーヒー を のみます か?");
	});

	it("reads inflected words on the surface and says where they came from", () => {
		const saw = word("昨日、友達と映画を見ました。", "見ました");
		assert.equal(saw.reading, "みました");
		assert.equal(saw.entries[0]!.reading, "見る みる · polite past");
		assert.match(saw.entries[0]!.defs[0]!, /to see/);
		const cases: [string, string, string][] = [
			["食べたくない", "たべたくない", "食べる たべる · want negative"],
			["行かなければなりません", "いかなければなりません", "行く いく · must polite"],
			["書いた", "かいた", "書く かく · past"],
			["新しかった", "あたらしかった", "新しい あたらしい · past"],
			["来ませんでした", "きませんでした", "来る くる · polite negative past"],
			["勉強させられた", "べんきょうさせられた", "勉強する べんきょうする · causative passive past"],
			["食べさせられませんでした", "たべさせられませんでした", "食べる たべる · causative passive polite negative past"],
		];
		for (const [text, reading, entry] of cases) {
			const g = gloss(text);
			assert.equal(g.words.length, 1, text);
			assert.equal(g.reading, reading);
			assert.equal(g.words[0]!.entries[0]!.reading, entry);
		}
	});

	it("takes する nouns with their する forms", () => {
		const g = gloss("日本語を勉強しています");
		assert.deepEqual(g.words.map((w) => w.text), ["日本語", "を", "勉強しています"]);
		assert.equal(g.reading, "にほんご を べんきょうしています");
		assert.equal(g.words[2]!.entries[0]!.reading, "勉強する べんきょうする · progressive polite");
		assert.match(g.words[2]!.entries[0]!.defs[0]!, /study/);
	});

	it("keeps katakana words and particles as written", () => {
		const g = gloss("コーヒーを飲みますか？");
		assert.deepEqual(g.words.map((w) => w.text), ["コーヒー", "を", "飲みます", "か", "？"]);
		assert.equal(g.words[0]!.reading, "コーヒー");
		assert.equal(g.words[0]!.entries[0]!.defs[0], "coffee");
		assert.equal(g.words[2]!.entries[0]!.reading, "飲む のむ · polite");
		assert.equal(word("私は学生です。", "は").reading, "は");
		assert.match(word("私は学生です。", "は").entries[0]!.defs[0]!, /topic/);
	});

	it("keeps the な of a na-adjective with it", () => {
		const g = gloss("静かな部屋");
		assert.deepEqual(g.words.map((w) => w.text), ["静かな", "部屋"]);
		assert.equal(g.reading, "しずかな へや");
		assert.equal(g.words[0]!.entries[0]!.reading, "静か しずか · attributive");
		assert.match(g.words[0]!.entries[0]!.defs[0]!, /quiet/);
	});

	it("ranks the everyday word first among kana homographs", () => {
		assert.match(word("猫がいる。", "いる").entries[0]!.defs[0]!, /to be \(of animate/);
		assert.equal(word("勉強して", "勉強して").entries[0]!.reading, "勉強する べんきょうする · te-form");
		assert.equal(gloss("して").words[0]!.entries[0]!.reading, "する · te-form");
		assert.equal(word("行った", "行った").entries[0]!.reading, "行く いく · past");
		assert.equal(word("本を読む", "本").reading, "ほん");
		// Common words read with their usual reading, not the one newspapers count (さくじつ).
		assert.equal(word("昨日", "昨日").reading, "きのう");
	});

	it("does not let longest match swallow particles", () => {
		assert.deepEqual(split("猫がいる。"), ["猫", "が", "いる", "。"]);
		assert.deepEqual(split("ねこがいる"), ["ねこ", "が", "いる"]);
		assert.deepEqual(split("今日は晴れです。"), ["今日", "は", "晴れ", "です", "。"]);
		assert.deepEqual(split("見せてもらえませんか"), ["見せて", "もらえません", "か"]);
		assert.equal(gloss("3時に会いましょう。").reading, "3 じ に あいましょう.");
		assert.deepEqual(split("3時間"), ["3", "時間"]);
	});

	it("keeps the popup small: at most 3 entries of 4 short defs", () => {
		for (const w of gloss("私はかけるといいました。行った").words) {
			assert.ok(w.entries.length <= 3, w.text);
			for (const e of w.entries) {
				assert.ok(e.defs.length >= 1 && e.defs.length <= 4, w.text);
				for (const d of e.defs) assert.ok(d.length <= 110, d);
			}
		}
	});
});
