"use client";

/** The sidebar's Review door, with today's due count — shown while a language is studied. */

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LayersIcon } from "lucide-react";
import type { AnkiQueueCounts } from "@/src/core";
import { useStudyProfile } from "@/components/language/status";
import { cn } from "@/lib/utils";

export function ReviewNavButton() {
	return useStudyProfile() ? <ReviewButton /> : null;
}

function ReviewButton() {
	const router = useRouter();
	const pathname = usePathname();
	const [due, setDue] = useState<number | null>(null);

	useEffect(() => {
		let alive = true;
		const refresh = () =>
			fetch("/api/anki/config", { cache: "no-store" })
				.then((r) => r.json() as Promise<{ counts: AnkiQueueCounts | null }>)
				.then(({ counts }) => alive && setDue(counts ? counts.new + counts.learning + counts.review : null))
				.catch(() => undefined);
		void refresh();
		const t = setInterval(refresh, 5 * 60_000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [pathname]);

	return (
		<button
			type="button"
			data-testid="open-review"
			onClick={() => router.push("/review")}
			className={cn(
				"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
				pathname === "/review" && "bg-accent text-foreground",
			)}
		>
			<LayersIcon className="size-3" />
			Review
			{due !== null && due > 0 && <span className="ml-auto font-mono tabular-nums normal-case tracking-normal">{due}</span>}
			<span className="sr-only">review due flashcards</span>
		</button>
	);
}
