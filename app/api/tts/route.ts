/** GET /api/tts?text=…&lang=ja-JP[&slow=1] — a spoken clip (Gemini TTS, cached on disk). */
import { ttsResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return ttsResponse(new URL(request.url).searchParams, request.headers.get("range"));
}
