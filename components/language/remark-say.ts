/**
 * remark plugin: wrap each run of Chinese or Japanese in an `lh-say` element
 * so the renderer can put a speaker button (and, where allowed, the reading
 * popup) on it — what it draws depends on the language being studied
 * (language/say.tsx). A run spans inline formatting — 我**在**公司 is one
 * phrase, not three — and skips code, links and math. Inline code holding
 * nothing but CJK (`明天我去`, the teacher quoting an example) is read as
 * plain text so it gets the button too; anything with Latin in it stays code.
 */

interface MdNode {
	type: string;
	value?: string;
	children?: MdNode[];
	data?: Record<string, unknown>;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
// A run: starts with a Han or kana character; continues through those, the
// prolonged-sound mark, CJK/fullwidth punctuation, and single spaces between them.
const RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}](?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー　-〿！-～·…—“”‘’]|\s(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]))*/gu;
const ONLY_CJKISH = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー　-〿！-～·…—“”‘’\s]+$/u;

const CONTAINERS = new Set(["paragraph", "heading", "tableCell"]);
const INLINE_WRAPPERS = new Set(["strong", "emphasis", "delete"]);
const SKIP = new Set(["code", "inlineCode", "link", "linkReference", "math", "inlineMath", "html"]);

function textOf(node: MdNode): string {
	if (typeof node.value === "string") return node.value;
	return (node.children ?? []).map(textOf).join("");
}

const isCjkOnly = (node: MdNode) => {
	const t = textOf(node);
	return CJK.test(t) && ONLY_CJKISH.test(t);
};

function say(children: MdNode[]): MdNode {
	return { type: "lhSay", children, data: { hName: "lh-say" } };
}

/** Rewrite one phrasing-content child list. */
function wrapRuns(children: MdNode[]): MdNode[] {
	// Split text nodes into CJK / other pieces; whole CJK-only inline wrappers count as CJK.
	const pieces: { node: MdNode; han: boolean }[] = [];
	for (const original of children) {
		const child = original.type === "inlineCode" && isCjkOnly(original) ? { type: "text", value: original.value } : original;
		if (child.type === "text" && child.value && CJK.test(child.value)) {
			let last = 0;
			for (const m of child.value.matchAll(RUN)) {
				const at = m.index ?? 0;
				if (at > last) pieces.push({ node: { type: "text", value: child.value.slice(last, at) }, han: false });
				pieces.push({ node: { type: "text", value: m[0] }, han: true });
				last = at + m[0].length;
			}
			if (last < child.value.length) pieces.push({ node: { type: "text", value: child.value.slice(last) }, han: false });
		} else if (INLINE_WRAPPERS.has(child.type) && isCjkOnly(child)) {
			pieces.push({ node: child, han: true });
		} else {
			if (INLINE_WRAPPERS.has(child.type) && child.children) child.children = wrapRuns(child.children);
			pieces.push({ node: child, han: false });
		}
	}
	const out: MdNode[] = [];
	let run: MdNode[] = [];
	const flush = () => {
		if (run.length) out.push(say(run));
		run = [];
	};
	for (const p of pieces) {
		if (p.han) run.push(p.node);
		else {
			flush();
			out.push(p.node);
		}
	}
	flush();
	return out;
}

function walk(node: MdNode): void {
	if (SKIP.has(node.type) || !node.children) return;
	if (CONTAINERS.has(node.type)) {
		node.children = wrapRuns(node.children);
		return;
	}
	node.children.forEach(walk);
}

export function remarkSay() {
	return (tree: MdNode) => walk(tree);
}

/** The plain text of a rendered `lh-say` hast element (what gets spoken). */
export function hastText(node: unknown): string {
	const n = node as { type?: string; value?: string; children?: unknown[] } | undefined;
	if (!n) return "";
	if (n.type === "text") return n.value ?? "";
	return (n.children ?? []).map(hastText).join("");
}
