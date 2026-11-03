/** GET /api/language — the studied language and whether speech is set up. */
import { languageStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(languageStatus(), { headers: { "Cache-Control": "no-store" } });
}
