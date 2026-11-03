"use client";

/**
 * One Anki card side, rendered with the card's own HTML + CSS inside a
 * sandboxed iframe (so the note type's styling can't leak into the app and
 * the app's can't break the card). Play buttons and key presses inside the
 * frame are forwarded to the parent with postMessage; the frame reports its
 * height so it never scrolls on its own.
 */

import { useEffect, useMemo, useRef, useState } from "react";

const FRAME_SCRIPT = `
document.addEventListener("click", (e) => {
	const b = e.target.closest(".lh-play");
	if (b) parent.postMessage({ lh: "play", side: b.dataset.side, idx: Number(b.dataset.idx) }, "*");
	else parent.postMessage({ lh: "tap" }, "*");
});
document.addEventListener("keydown", (e) => parent.postMessage({ lh: "key", key: e.key }, "*"));
new ResizeObserver(() => parent.postMessage({ lh: "height", h: document.documentElement.scrollHeight }, "*"))
	.observe(document.body);
`;

const FRAME_STYLE = `
html, body { margin: 0; }
body { padding: 12px; box-sizing: border-box; }
body { -webkit-text-size-adjust: 100%; }
.card { min-height: 100%; box-sizing: border-box; }
img { max-width: 100%; height: auto; }
.lh-play {
	display: inline-flex; align-items: center; justify-content: center;
	width: 2.2em; height: 2.2em; margin: 0.2em; border-radius: 999px;
	border: 1px solid rgba(127,127,127,.45); background: rgba(127,127,127,.15);
	color: inherit; font-size: 15px; cursor: pointer; vertical-align: middle;
}
`;

export type FrameMessage =
	| { lh: "play"; side: "q" | "a"; idx: number }
	| { lh: "key"; key: string }
	| { lh: "tap" }
	| { lh: "height"; h: number };

export function buildCardDocument(html: string, css: string, ord = 0): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${FRAME_STYLE}</style></head><body class="card card${ord + 1}"><div>${html}</div><script>${FRAME_SCRIPT}</script></body></html>`;
}

export function CardFrame({ html, css, onMessage }: { html: string; css: string; onMessage: (m: FrameMessage) => void }) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(240);
	const doc = useMemo(() => buildCardDocument(html, css), [html, css]);
	const handler = useRef(onMessage);
	handler.current = onMessage;

	useEffect(() => {
		const listen = (e: MessageEvent) => {
			if (e.source !== ref.current?.contentWindow) return;
			const m = e.data as FrameMessage;
			if (!m || typeof m !== "object" || !("lh" in m)) return;
			if (m.lh === "height") setHeight(Math.max(120, Math.ceil(m.h)));
			else handler.current(m);
		};
		window.addEventListener("message", listen);
		return () => window.removeEventListener("message", listen);
	}, []);

	return (
		<iframe
			ref={ref}
			title="Anki card"
			sandbox="allow-scripts"
			srcDoc={doc}
			style={{ height }}
			className="w-full rounded-lg border border-border bg-transparent"
		/>
	);
}
