/**
 * The language-learning layer's pure pieces: the studied-language setting,
 * Anki template → av tags, card HTML rewriting, config + proposal parsing,
 * audio-field pairing, the lh-say remark plugin, WAV encoding, and the
 * Range-aware byte response.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ankiAddDeck,
	avTagsForTemplate,
	parseAnkiProposals,
	rewriteCardHtml,
	sanitizeAnkiConfig,
	DEFAULT_ANKI_CONFIG,
} from "../src/core/anki.ts";
import { profileForSpeech, studyLanguageOf } from "../src/core/languages.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { pairAudioFields } from "../src/server/anki.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { ankiTools } from "../src/agent/tools/anki.ts";
import { LANGUAGES } from "../src/core/languages.ts";
import { remarkSay } from "../components/language/remark-say.ts";
import { encodeWav } from "../components/language/wav.ts";
import { bytesResponse } from "../src/server/media-response.ts";
import { geminiLanguageCode } from "../src/server/tts.ts";

describe("the studied language", () => {
	it("defaults to Chinese, turns off with none, and drops unknown values", () => {
		assert.equal(studyLanguageOf(undefined), "zh");
		assert.equal(studyLanguageOf({ language: "ja" }), "ja");
		assert.equal(studyLanguageOf({ language: "none" }), null);
		assert.equal(sanitizeUserSettings({ version: 1, agent: { language: "ko" } })?.agent?.language, undefined);
		assert.equal(sanitizeUserSettings({ version: 1, agent: { language: "none" } })?.agent?.language, "none");
	});

	it("validates the agent PUT strictly", () => {
		assert.deepEqual(parseAgentSettingsBody({ language: "ja" }), { ok: true, settings: { language: "ja" } });
		assert.equal(parseAgentSettingsBody({ language: "ko" }).ok, false);
	});

	it("composes only the studied language's fragment into each tutor", () => {
		assert.doesNotMatch(composeInstructions("teacher"), /Teaching Mandarin|Teaching Japanese/);
		assert.match(composeInstructions("teacher", {}, "zh"), /## Teaching Mandarin/);
		assert.match(composeInstructions("prober", {}, "ja"), /## Japanese learners/);
		assert.doesNotMatch(composeInstructions("teacher", {}, "ja"), /Mandarin/);
		assert.equal(composeInstructions("practice", {}, "zh"), composeInstructions("practice"));
	});

	it("describes the Anki card fields in the studied language", () => {
		const tools = ankiTools({ port: { lookup: async () => "", cards: async () => "" }, language: LANGUAGES.ja });
		const schema = JSON.stringify(tools.anki_propose_cards!.parameters);
		assert.match(schema, /hiragana/);
		assert.doesNotMatch(schema, /pinyin|Chinese/);
	});

	it("finds the profile for an Anki or BCP-47 speech tag", () => {
		assert.equal(profileForSpeech("zh_CN")?.id, "zh");
		assert.equal(profileForSpeech("cmn-Hans")?.id, "zh");
		assert.equal(profileForSpeech("ja-JP")?.id, "ja");
		assert.equal(profileForSpeech("en_US"), undefined);
	});
});

describe("avTagsForTemplate", () => {
	const speakBack =
		'{{FrontSide}} <hr id="answer"> {{Pinyin}} {{#Audio}}native {{Audio}}{{/Audio}} {{#AudioSlow}}teacher {{AudioSlow}}{{/AudioSlow}} ' +
		"{{^Audio}}{{^AudioSlow}}{{tts zh_CN:Front}}{{/AudioSlow}}{{/Audio}}";

	it("numbers the answer side's sounds in template order, skipping FrontSide", () => {
		const tags = avTagsForTemplate(speakBack, { Front: "你好！", Audio: "[sound:a.mp3]", AudioSlow: "[sound:b.mp3]" });
		assert.deepEqual(tags, [
			{ kind: "sound", file: "a.mp3" },
			{ kind: "sound", file: "b.mp3" },
		]);
	});

	it("falls back to the tts tag when both audio fields are empty", () => {
		const tags = avTagsForTemplate(speakBack, { Front: "<b>你好</b>！", Audio: "", AudioSlow: "" });
		assert.deepEqual(tags, [{ kind: "tts", lang: "zh_CN", text: "你好！" }]);
	});

	it("reads filtered fields and several sounds per field", () => {
		const tags = avTagsForTemplate("{{text:Audio}} {{SentenceAudio}}", {
			Audio: "[sound:x.mp3][sound:y.mp3]",
			SentenceAudio: "[sound:s.mp3]",
		});
		assert.deepEqual(
			tags.map((t) => (t.kind === "sound" ? t.file : t.text)),
			["x.mp3", "y.mp3", "s.mp3"],
		);
	});
});

describe("rewriteCardHtml", () => {
	it("turns play placeholders into buttons, points images at the media route, drops <style>", () => {
		const html = rewriteCardHtml('<style>.x{}</style><div>的</div>[anki:play:a:1] <img src="3l dc.jpg"> <img src="https://e.com/a.png">');
		assert.equal(html.includes("<style>"), false);
		assert.match(html, /class="lh-play" data-side="a" data-idx="1"/);
		assert.match(html, /src="\/api\/anki\/media\/3l%20dc\.jpg"/);
		assert.match(html, /src="https:\/\/e\.com\/a\.png"/);
	});
});

describe("config + proposals", () => {
	it("sanitizes the config", () => {
		assert.deepEqual(sanitizeAnkiConfig(null), DEFAULT_ANKI_CONFIG);
		assert.deepEqual(sanitizeAnkiConfig({ url: "ftp://x", decks: ["A", "A", 3, " B "], addDeck: "" }), {
			url: DEFAULT_ANKI_CONFIG.url,
			decks: ["A", "B"],
			addDeck: DEFAULT_ANKI_CONFIG.addDeck,
		});
	});

	it("parses proposals, dropping incomplete cards and reading older chinese/pinyin/english ones", () => {
		const cards = parseAnkiProposals({
			cards: [
				{ kind: "produce", text: "明日行きます", reading: "あしたいきます", meaning: "I'll go tomorrow" },
				{ kind: "speak", text: "", meaning: "x" },
				{ kind: "weird", chinese: "好", pinyin: "hǎo", english: "good", note: " " },
			],
		});
		assert.equal(cards.length, 2);
		assert.equal(cards[0]?.kind, "produce");
		assert.deepEqual(cards[1], { kind: "speak", text: "好", reading: "hǎo", meaning: "good" });
	});

	it("files new cards under the studied language unless a deck is configured", () => {
		assert.equal(ankiAddDeck(DEFAULT_ANKI_CONFIG, "Japanese"), "Japanese::LearnHarness");
		assert.equal(ankiAddDeck({ ...DEFAULT_ANKI_CONFIG, addDeck: "Mine" }, "Japanese"), "Mine");
	});
});

describe("pairAudioFields", () => {
	const pairs = (fields: string[], voiced = (_: string) => true) =>
		Object.fromEntries(pairAudioFields(fields, voiced).map((p) => [p.text, [p.audio, p.slow]]));

	it("pairs fields by name stem, with a bare Audio voicing only the headword", () => {
		assert.deepEqual(pairs(["Simplified", "SentenceSimplified", "Audio", "SentenceAudio"]), {
			Simplified: ["Audio", undefined],
			SentenceSimplified: ["SentenceAudio", undefined],
		});
		assert.deepEqual(pairs(["Vocabulary-Kanji", "Vocabulary-Audio", "Sentence-Kanji", "Sentence-Audio"]), {
			"Vocabulary-Kanji": ["Vocabulary-Audio", undefined],
			"Sentence-Kanji": ["Sentence-Audio", undefined],
		});
		assert.deepEqual(pairs(["Hanzi", "Example", "Audio"]), { Hanzi: ["Audio", undefined], Example: [undefined, undefined] });
		assert.deepEqual(pairs(["Front", "Back", "Audio", "AudioSlow"], (f) => f === "Front"), { Front: ["Audio", "AudioSlow"] });
	});
});

describe("remarkSay", () => {
	type N = { type: string; value?: string; children?: N[] };
	const run = (tree: N) => {
		remarkSay()(tree as never);
		return tree;
	};
	const says = (n: N): string[] =>
		n.type === "lhSay"
			? [(n.children ?? []).map(function t(c: N): string { return c.value ?? (c.children ?? []).map(t).join(""); }).join("")]
			: (n.children ?? []).flatMap(says);

	it("wraps a Chinese run across bold, leaving English alone", () => {
		const tree = run({
			type: "root",
			children: [
				{
					type: "paragraph",
					children: [
						{ type: "text", value: "Say 我" },
						{ type: "strong", children: [{ type: "text", value: "在" }] },
						{ type: "text", value: "公司。 then 你好" },
					],
				},
			],
		});
		assert.deepEqual(says(tree), ["我在公司。", "你好"]);
	});

	it("wraps Japanese runs, kana and the long-vowel mark included", () => {
		const tree = run({
			type: "root",
			children: [{ type: "paragraph", children: [{ type: "text", value: "Try コーヒーを飲みますか？ or ください" }] }],
		});
		assert.deepEqual(says(tree), ["コーヒーを飲みますか？", "ください"]);
	});

	it("skips code and links", () => {
		const tree = run({
			type: "root",
			children: [
				{ type: "code", value: "你好" },
				{ type: "paragraph", children: [{ type: "link", children: [{ type: "text", value: "中文" }] }] },
			],
		});
		assert.deepEqual(says(tree), []);
	});

	it("reads Chinese-only inline code as text, keeping code with Latin in it", () => {
		const tree = run({
			type: "root",
			children: [
				{
					type: "paragraph",
					children: [
						{ type: "text", value: '"I tomorrow go" (' },
						{ type: "inlineCode", value: "我明天去" },
						{ type: "text", value: ") or " },
						{ type: "inlineCode", value: "我 + 去" },
					],
				},
			],
		});
		assert.deepEqual(says(tree), ["我明天去"]);
		assert.equal(tree.children![0]!.children![3]!.type, "inlineCode");
	});
});

describe("audio plumbing", () => {
	it("encodes a mono 16-bit WAV", () => {
		const wav = encodeWav([new Int16Array([1, -1]), new Int16Array([2])], 16000);
		assert.equal(wav.length, 44 + 6);
		assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
		assert.equal(new DataView(wav.buffer).getUint32(24, true), 16000);
		assert.equal(new DataView(wav.buffer).getInt16(46, true), -1);
	});

	it("answers byte ranges (Safari audio)", async () => {
		const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
		const part = bytesResponse(bytes, "audio/wav", "bytes=2-3");
		assert.equal(part.status, 206);
		assert.equal(part.headers.get("content-range"), "bytes 2-3/6");
		assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [2, 3]);
		assert.equal(bytesResponse(bytes, "audio/wav", "bytes=9-").status, 416);
		assert.equal(bytesResponse(bytes, "audio/wav", null).status, 200);
	});

	it("sends zh-CN for every Mandarin tag (the HyperTTS decks' code)", () => {
		assert.equal(geminiLanguageCode("zh_CN"), "zh-CN");
		assert.equal(geminiLanguageCode("cmn-CN"), "zh-CN");
		assert.equal(geminiLanguageCode("en-US"), "en-US");
	});
});

describe("audio usage pricing", async () => {
	const { audioCallCost, audioPricing, audioRateKey, geminiUsageTokens } = await import("../src/core/audio-usage.ts");
	const base = { at: "2026-10-26T12:00:00Z", chatId: "chat_x", textInputTokens: 0, audioInputTokens: 0, outputTokens: 0 };

	it("matches model versions to the longest known id", () => {
		assert.equal(audioRateKey("gemini-3.8-flash-tts"), "gemini-3.8-flash-tts");
		assert.equal(audioRateKey("gemini-3.8-flash-lite-tts"), "gemini-3.8-flash-lite-tts");
		assert.equal(audioRateKey("models/gemini-3.8-flash-001"), "gemini-3.8-flash");
		assert.equal(audioRateKey("gemini-2.5-flash-lite"), "gemini-2.5-flash-lite");
		assert.equal(audioRateKey("gpt-4o"), undefined);
	});

	it("prices a TTS clip: text in, audio out — and the 2027 increase", () => {
		const clip = { ...base, kind: "tts" as const, model: "gemini-3.8-flash-tts", textInputTokens: 20, outputTokens: 1000 };
		assert.equal(audioCallCost(clip), (20 * 0.5 + 1000 * 9) / 1e6);
		assert.equal(audioCallCost({ ...clip, at: "2027-01-02T00:00:00Z" }), (20 * 1 + 1000 * 18) / 1e6);
	});

	it("uses the audio input rate where Google prices it separately", () => {
		const stt = { ...base, kind: "stt" as const, model: "gemini-2.5-flash", textInputTokens: 100, audioInputTokens: 400, outputTokens: 50 };
		assert.equal(audioCallCost(stt), (100 * 0.3 + 400 * 1 + 50 * 2.5) / 1e6);
	});

	it("splits Gemini usage metadata (thinking counts as output)", () => {
		assert.deepEqual(
			geminiUsageTokens({
				promptTokenCount: 500,
				candidatesTokenCount: 12,
				thoughtsTokenCount: 30,
				promptTokensDetails: [{ modality: "AUDIO", tokenCount: 420 }, { modality: "TEXT", tokenCount: 80 }],
			}),
			{ textInputTokens: 80, audioInputTokens: 420, outputTokens: 42 },
		);
		assert.deepEqual(geminiUsageTokens(undefined), { textInputTokens: 0, audioInputTokens: 0, outputTokens: 0 });
	});

	it("folds a lesson's entries, counting unknown models as unpriced", () => {
		const p = audioPricing([
			{ ...base, kind: "tts", model: "gemini-3.8-flash-tts", outputTokens: 1_000_000 },
			{ ...base, kind: "stt", model: "mystery-model", textInputTokens: 10 },
		]);
		assert.deepEqual(p, { cost: 9, clips: 1, transcriptions: 1, unpriced: 1 });
	});
});
