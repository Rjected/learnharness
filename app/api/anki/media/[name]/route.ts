/** GET /api/anki/media/:name — a file from Anki's media folder (audio, images). */
import { ankiMediaResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
	const { name } = await ctx.params;
	return ankiMediaResponse(decodeURIComponent(name), request.headers.get("range"));
}
