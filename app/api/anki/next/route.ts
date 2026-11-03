/** GET /api/anki/next — the next card to review (or why there is none). */
import { ankiNext } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(await ankiNext());
}
