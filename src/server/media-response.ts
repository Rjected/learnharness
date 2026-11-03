/**
 * Byte responses for audio/images that honour `Range` —
 * Safari on the phone refuses to play audio from a server that can't answer
 * byte ranges.
 */

export function bytesResponse(bytes: Uint8Array<ArrayBuffer>, contentType: string, range: string | null): Response {
	const headers: Record<string, string> = {
		"content-type": contentType,
		"accept-ranges": "bytes",
		"cache-control": "private, max-age=86400",
	};
	const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
	if (m && (m[1] || m[2])) {
		const start = m[1] ? Number(m[1]) : Math.max(0, bytes.length - Number(m[2]));
		const end = m[1] && m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
		if (start > end || start >= bytes.length) {
			return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
		}
		return new Response(bytes.subarray(start, end + 1), {
			status: 206,
			headers: { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(end - start + 1) },
		});
	}
	return new Response(bytes, { headers: { ...headers, "content-length": String(bytes.length) } });
}
