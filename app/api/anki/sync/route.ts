/** POST /api/anki/sync — sync with AnkiWeb; answers once the sync has finished. */
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
