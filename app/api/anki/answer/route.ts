/** POST /api/anki/answer {cardId, ease} — grade a card; Anki reschedules it. */
import { ankiAnswer } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { cardId?: unknown; ease?: unknown } | null;
	const cardId = Number(body?.cardId);
	const ease = Number(body?.ease);
	if (!Number.isSafeInteger(cardId) || ![1, 2, 3, 4].includes(ease)) {
		return Response.json({ error: "cardId and ease (1-4) required" }, { status: 400 });
	}
	try {
		await ankiAnswer(cardId, ease as 1 | 2 | 3 | 4);
		return Response.json({ ok: true });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
	}
}
