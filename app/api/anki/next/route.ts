/** GET /api/anki/next?deck=<separate deck> — the next card to review in that session (no deck = daily), or why there is none. */
import { ankiNext } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return Response.json(await ankiNext(new URL(request.url).searchParams.get("deck")));
}
