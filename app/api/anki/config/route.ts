/**
 * GET /api/anki/config — the review config plus Anki's deck list and today's
 * counts (decks/counts are null when Anki is closed).
 * PUT /api/anki/config — save the config (sanitized).
 */
import { ankiCounts, ankiDeckNames, readAnkiConfig, writeAnkiConfig } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const [decks, counts] = await Promise.all([ankiDeckNames().catch(() => null), ankiCounts()]);
	return Response.json({ config: readAnkiConfig(), decks, counts });
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null);
	if (!body) return Response.json({ error: "JSON body required" }, { status: 400 });
	return Response.json({ config: writeAnkiConfig(body) });
}
