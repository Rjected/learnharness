import { ReviewSession } from "@/components/review/review-session";

export const dynamic = "force-dynamic";

/** Anki reviews inside LearnHarness — Anki still schedules. */
export default function ReviewPage() {
	return <ReviewSession />;
}
