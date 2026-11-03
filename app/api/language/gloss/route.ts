/** GET /api/language/gloss?text=… — the reading and dictionary senses for a run of the studied language. */
import { glossResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
	return glossResponse(new URL(request.url).searchParams);
}
