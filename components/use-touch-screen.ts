"use client";

import { useEffect, useState } from "react";

/**
 * A touch screen (coarse pointer) — the phone. False until mounted, so the
 * server and the first client render agree; follows the media query after.
 */
export function useTouchScreen(): boolean {
	const [touch, setTouch] = useState(false);
	useEffect(() => {
		const mq = window.matchMedia?.("(pointer: coarse)");
		if (!mq) return;
		const update = () => setTouch(mq.matches);
		update();
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	}, []);
	return touch;
}
