/** POST /api/anki/sync — push today's reviews to AnkiWeb. */
import { ankiSync } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	try {
		await ankiSync();
		return Response.json({ ok: true });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
	}
}
