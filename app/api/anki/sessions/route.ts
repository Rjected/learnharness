/** GET /api/anki/sessions — the Review sessions (daily, then each separate deck) with due counts; null when Anki is closed. */
import { ankiSessions } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ sessions: await ankiSessions() });
}
