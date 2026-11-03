/**
 * Enter-to-submit, except on touch screens. On a phone the
 * keyboard's return key is how you start a new line, and a stray tap must
 * never send a half-written answer — so there only the on-screen button
 * submits. ⌘/Ctrl+Enter still submits everywhere (hardware keyboards), and
 * Enter that confirms an IME composition (pinyin input) never submits.
 */
import type { KeyboardEvent } from "react";

export function isTouchKeyboard(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

/** True when this keydown should submit the field it came from. */
export function enterSubmits(e: KeyboardEvent): boolean {
	if (e.key !== "Enter" || e.nativeEvent.isComposing) return false;
	if (e.metaKey || e.ctrlKey) return true;
	return !e.shiftKey && !isTouchKeyboard();
}
