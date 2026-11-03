/** 16-bit mono PCM frames → a WAV file (recorded dictation clips). Pure. */

export function encodeWav(frames: Int16Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
	const samples = frames.reduce((n, f) => n + f.length, 0);
	const out = new Uint8Array(44 + samples * 2);
	const view = new DataView(out.buffer);
	const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
	ascii(0, "RIFF");
	view.setUint32(4, 36 + samples * 2, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, samples * 2, true);
	let at = 44;
	for (const frame of frames) {
		for (const s of frame) {
			view.setInt16(at, s, true);
			at += 2;
		}
	}
	return out;
}
