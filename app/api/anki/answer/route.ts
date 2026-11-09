/** POST /api/anki/answer {cardId, ease, elapsedMs} — grade a card; Anki reschedules it and logs the time. */
import { ankiAnswer } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { cardId?: unknown; ease?: unknown; elapsedMs?: unknown } | null;
	const cardId = Number(body?.cardId);
	const ease = Number(body?.ease);
	const elapsedMs = Number(body?.elapsedMs);
	if (!Number.isSafeInteger(cardId) || ![1, 2, 3, 4].includes(ease) || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
		return Response.json({ error: "cardId, ease (1-4) and elapsedMs required" }, { status: 400 });
	}
	try {
		await ankiAnswer(cardId, ease as 1 | 2 | 3 | 4, elapsedMs);
		return Response.json({ ok: true });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
	}
}
