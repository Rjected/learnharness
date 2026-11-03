/** POST /api/anki/add {card} — add one teacher-proposed card to Anki (the learner's click). */
import { parseAnkiProposals } from "@/src/core";
import { ankiAddProposal, chatParam } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { card?: unknown; chatId?: unknown } | null;
	const [card] = parseAnkiProposals({ cards: [body?.card] });
	if (!card) return Response.json({ ok: false, duplicate: false, error: "A card needs text and meaning" }, { status: 400 });
	const result = await ankiAddProposal(card, chatParam(typeof body?.chatId === "string" ? body.chatId : null));
	return Response.json(result, { status: result.ok || result.duplicate ? 200 : 502 });
}
