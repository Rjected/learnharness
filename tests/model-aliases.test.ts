/**
 * Google -latest aliases are priced at the model Google serves (chinese
 * branch): the one-token probe's modelVersion is cached and pricing uses it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-aliases-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.GEMINI_API_KEY = "test-key";

const { refreshGoogleAlias, googleAliasTarget, isGoogleAlias } = await import("../src/server/model-aliases.ts");
const { callCost } = await import("../src/server/pricing.ts");

describe("Google alias pricing", () => {
	it("only treats Google -latest ids as aliases", () => {
		assert.equal(isGoogleAlias("google", "gemini-flash-latest"), true);
		assert.equal(isGoogleAlias("google", "gemini-3.8-flash"), false);
		assert.equal(isGoogleAlias("openai", "gpt-latest"), false);
	});

	it("caches the served model and prices the alias at it", async () => {
		const realFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ modelVersion: "gemini-3.8-flash" }), { status: 200 });
		}) as typeof fetch;
		try {
			const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
			assert.equal(await refreshGoogleAlias("gemini-flash-latest"), "gemini-3.8-flash");
			assert.equal(googleAliasTarget("gemini-flash-latest"), "gemini-3.8-flash");
			assert.equal(calls, 1, "a fresh entry is not re-probed");
			assert.equal(callCost(usage, "google:gemini-flash-latest"), callCost(usage, "google:gemini-3.8-flash"));
			const saved = JSON.parse(fs.readFileSync(path.join(dir, "model-aliases.json"), "utf-8"));
			assert.equal(saved["gemini-flash-latest"].target, "gemini-3.8-flash");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
