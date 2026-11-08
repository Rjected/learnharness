/**
 * GET /api/anki/config — the review config plus Anki's deck list and today's
 * daily counts (decks/counts are null when Anki is closed). The ids of the
 * cards LearnHarness suspended stay on the server.
 * PUT /api/anki/config — save the config (sanitized), suspending or
 * unsuspending cards in Anki for decks paused or resumed.
 */
import { ankiCounts, ankiDeckNames, AnkiOfflineError, readAnkiConfig, saveAnkiConfig } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const [decks, counts] = await Promise.all([ankiDeckNames().catch(() => null), ankiCounts()]);
	const { pausedCards: _, ...config } = readAnkiConfig();
	return Response.json({ config, decks, counts });
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null);
	if (!body) return Response.json({ error: "JSON body required" }, { status: 400 });
	try {
		const { pausedCards: _, ...config } = await saveAnkiConfig(body);
		return Response.json({ config });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: err instanceof AnkiOfflineError ? 503 : 500 });
	}
}
