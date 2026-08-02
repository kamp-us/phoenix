/**
 * `report file`'s composition half, pure: the six-section check, the footer, and the
 * classification refusal.
 *
 * **This module owns the validated spelling and order of the sections.** The skill necessarily
 * names the same six headings — a model cannot author under a section it cannot name — so the two
 * are a guarded duplicate rather than a single source, and the section refusal is the mechanism
 * that catches the skill drifting from the verb.
 */

export const REQUIRED_SECTIONS: ReadonlyArray<string> = [
	"## Summary",
	"## What I was doing",
	"## What I observed",
	"## Why it matters",
	"## Pointers",
	"## Suggested next step (non-binding)",
];

/** A blank guess beats a misleading one, so the last section alone may carry nothing. */
const MAY_BE_EMPTY = "## Suggested next step (non-binding)";

export type SectionProblem =
	| {readonly _tag: "Missing"; readonly heading: string}
	| {readonly _tag: "Empty"; readonly heading: string}
	| {readonly _tag: "OutOfOrder"; readonly heading: string; readonly after: string};

interface Seen {
	readonly heading: string;
	readonly content: string;
}

/** The `##` sections of a markdown body, in the order they appear, with their content. */
const sectionsOf = (body: string): ReadonlyArray<Seen> => {
	const lines = body.split("\n");
	const seen: {heading: string; content: string[]}[] = [];
	for (const line of lines) {
		const m = /^##\s+(.*?)\s*$/.exec(line);
		if (m?.[1] !== undefined) seen.push({heading: `## ${m[1]}`, content: []});
		else seen.at(-1)?.content.push(line);
	}
	return seen.map((s) => ({heading: s.heading, content: s.content.join("\n")}));
};

/**
 * The first thing wrong with the six sections, or `null`.
 *
 * One problem at a time, and in this precedence — missing, then order, then empty — because every
 * refusal in this skill names exactly one correctable thing, so a second attempt is a correction
 * rather than a rewrite.
 */
export const checkSections = (body: string): SectionProblem | null => {
	const seen = sectionsOf(body);
	const headings = seen.map((s) => s.heading);

	for (const required of REQUIRED_SECTIONS) {
		if (!headings.includes(required)) return {_tag: "Missing", heading: required};
	}

	const ordered = headings.filter((h) => REQUIRED_SECTIONS.includes(h));
	for (let i = 1; i < ordered.length; i += 1) {
		const previous = ordered[i - 1];
		const current = ordered[i];
		if (previous === undefined || current === undefined) continue;
		if (REQUIRED_SECTIONS.indexOf(current) < REQUIRED_SECTIONS.indexOf(previous)) {
			return {_tag: "OutOfOrder", heading: current, after: previous};
		}
	}

	for (const required of REQUIRED_SECTIONS) {
		if (required === MAY_BE_EMPTY) continue;
		const section = seen.find((s) => s.heading === required);
		if (section === undefined || section.content.trim() === "") {
			return {_tag: "Empty", heading: required};
		}
	}
	return null;
};

export interface FooterFields {
	readonly session: string | null;
	readonly model: string | null;
	/** A ref, never a path — the only repo-shaped field, and detached HEAD resolves to `null`. */
	readonly branch: string | null;
	readonly timestamp: string;
}

/**
 * The footer, joined with ` · ` over the **present fields only** — a dropped field takes its
 * separator with it. There is no placeholder, no `unknown`, and no dangling label.
 *
 * `Filed by an agent` is never omitted: it is ADR 0159's never-auto-close signal, and GitHub
 * authorship cannot serve it because every pipeline-filed issue goes through one shared login.
 * Privacy is this verb's precondition, not the caller's — no email, no author name, no path.
 */
export const renderFooter = (fields: FooterFields): string => {
	const parts = [
		"Filed by an agent",
		fields.session === null ? null : `session \`${fields.session}\``,
		fields.model === null ? null : `model \`${fields.model}\``,
		fields.branch === null ? null : `branch \`${fields.branch}\``,
		fields.timestamp,
	].filter((p): p is string => p !== null);
	return `---\n<sub>${parts.join(" · ")}</sub>`;
};

/** The sections plus the footer, after a blank line. */
export const composeBody = (sections: string, footer: string): string =>
	`${sections.replace(/\s+$/, "")}\n\n${footer}\n`;

export interface Vocabulary {
	readonly typeLabels: ReadonlySet<string>;
	readonly priorityLabels: ReadonlySet<string>;
	/** Lowercased bare words a classifying title prefix is matched against. */
	readonly words: ReadonlyMap<string, "type" | "priority">;
}

/**
 * The type and priority vocabulary, **derived from the target repo's own label set** rather than a
 * hardcoded list that rots.
 *
 * Which names count is a shape rule, because the contract does not give one: `type:*` is a type
 * label, and `priority:*` **or** a bare `p<digits>` is a priority label — the second spelling is
 * what this repo actually uses (`p0`/`p1`/`p2`), and a rule that only read `priority:` would derive
 * an empty priority vocabulary here and wave `P0: …` straight through.
 */
export const deriveVocabulary = (labels: ReadonlyArray<string>): Vocabulary => {
	const typeLabels = new Set<string>();
	const priorityLabels = new Set<string>();
	const words = new Map<string, "type" | "priority">();
	for (const label of labels) {
		const lower = label.toLowerCase();
		if (lower.startsWith("type:")) {
			typeLabels.add(label);
			words.set(lower.slice("type:".length), "type");
		} else if (lower.startsWith("priority:")) {
			priorityLabels.add(label);
			words.set(lower.slice("priority:".length), "priority");
		} else if (/^p\d+$/.test(lower)) {
			priorityLabels.add(label);
			words.set(lower, "priority");
		}
	}
	return {typeLabels, priorityLabels, words};
};

export const labelKind = (label: string, vocabulary: Vocabulary): "type" | "priority" | null => {
	if (vocabulary.typeLabels.has(label)) return "type";
	if (vocabulary.priorityLabels.has(label)) return "priority";
	return null;
};

/**
 * The classifying prefix a title leads with, or `null`.
 *
 * The refusal needs **both** conditions: the leading token has a `WORD:` or `[WORD]` shape, and
 * that word resolves to the repo's vocabulary. Both together, so `BUG: fix retry` refuses while
 * `Bug reports from the sozluk form are lost` files cleanly — the shape alone would reject a
 * legitimate title whose first word happens to be a vocabulary term.
 */
export const classifyingPrefix = (title: string, vocabulary: Vocabulary): string | null => {
	const m = /^\s*(?:([A-Za-z][\w-]*):|\[([A-Za-z][\w-]*)\])/.exec(title);
	const word = m?.[1] ?? m?.[2];
	if (m === null || word === undefined) return null;
	return vocabulary.words.has(word.toLowerCase()) ? m[0].trim() : null;
};

/**
 * The comparison the read-back asserts on.
 *
 * Byte-identity is the intent, but this package does **not** assert that the GitHub issue
 * round-trip preserves bytes exactly — that would be an unverified claim about a dependency, and
 * if it is false the read-back refusal fires on every clean filing. Line endings are normalised
 * to `\n` and per-line trailing whitespace is stripped; tighten to byte-identity only against
 * evidence from the real API.
 */
export const normalizeForReadback = (text: string): string =>
	text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
