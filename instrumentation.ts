/** Server start-up (Next calls `register` once per server): the Anki bridge's background sync with AnkiWeb. */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const [{ startAnkiAutoSync }, { studyProfile }] = await Promise.all([import("./src/server/anki.ts"), import("./src/server/language.ts")]);
	startAnkiAutoSync(() => studyProfile() !== null);
}
