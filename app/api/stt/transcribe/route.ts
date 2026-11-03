/** POST /api/stt/transcribe — a recorded clip in, a mixed English + studied-language transcript out (Gemini). */
import { transcribeResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return transcribeResponse(request);
}
