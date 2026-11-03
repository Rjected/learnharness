"use client";

/**
 * A run of the studied language in rendered markdown (remark-say.ts), with a
 * speaker button after it and, where the surrounding block allows, the
 * reading popup. No language studied → the plain text. No Google key yet →
 * a dimmed speaker that opens Settings → Keys → Audio, where setup is three
 * steps; once a key is saved every speaker lights up.
 */

import { useRef, type ReactNode } from "react";
import { Volume2Icon } from "lucide-react";
import { SPEECH_KEY_ID, LANGUAGES } from "@/src/core";
import { cn } from "@/lib/utils";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { speak, unlockAudio } from "@/components/language/player";
import { hastText } from "@/components/language/remark-say";
import { GlossPopup, useGlossScope } from "@/components/language/gloss";
import { useLanguageStatus } from "@/components/language/status";

export function Say({ node, children }: { node?: unknown; children?: ReactNode }) {
	const text = hastText(node).trim();
	const status = useLanguageStatus();
	const glossAllowed = useGlossScope();
	const { open: openSettings } = useSettingsDialog();
	const lastTap = useRef(0);
	if (!status?.language) return <>{children}</>;
	const profile = LANGUAGES[status.language];

	// A second tap within a few seconds replays in the slow teacher voice (phones have no Shift).
	const play = (shift: boolean) => {
		if (!status.tts) return openSettings("keys", SPEECH_KEY_ID);
		const now = Date.now();
		const slow = shift || now - lastTap.current < 4000;
		lastTap.current = slow ? 0 : now;
		unlockAudio();
		void speak(text, { lang: profile.speech, slow });
	};
	return (
		<span className="lh-say" lang={profile.speech}>
			{glossAllowed ? <GlossPopup text={text}>{children}</GlossPopup> : children}
			{/* A span, not a <button>: these runs often sit inside quiz options, which are buttons themselves. */}
			<span
				role="button"
				tabIndex={0}
				aria-label={status.tts ? `Play ${text}` : "Set up audio"}
				title={status.tts ? "Play (tap again for slow)" : "Set up audio: add a free Google key"}
				onClick={(e) => {
					e.stopPropagation();
					e.preventDefault();
					play(e.shiftKey);
				}}
				onKeyDown={(e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.stopPropagation();
					e.preventDefault();
					play(e.shiftKey);
				}}
				className={cn(
					"lh-say-play ml-0.5 inline-flex size-5 translate-y-[-1px] cursor-pointer items-center justify-center rounded align-middle text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground",
					!status.tts && "opacity-40",
				)}
			>
				<Volume2Icon className="size-3.5" />
			</span>
		</span>
	);
}
