/**
 * `glossary-drift` pure core — decide which concept-shaped phrases in a window of
 * recent merges are NOT yet in `.glossary/TERMS.md`, so an out-of-band sweep can
 * file them as candidate vocabulary drift (ADR 0128 prong (b), issue #1748).
 *
 * This is the backstop for the class the fail-closed `review-code` Step 3c gate
 * structurally cannot see: a concept-level vocabulary shift in a **regular code PR
 * that never routes through `/adr` or `plan-epic`** (the grounded miss #1726 — the
 * release-lever redefinition "split serving" / "kill switch" landed in a plain
 * `feat(cf-utils)` PR with zero glossary pressure). The gate reads structural path
 * signals (new folder / package / export); it never reads the *words* an author used
 * to name what they shipped. This core does exactly that, off the blocking path.
 *
 * IO-free and total: every decision is a deterministic transform over already-gathered
 * facts (the TERMS.md text and the recent merge-commit lines). The git/gh/fs boundary
 * (fetch the merge window, read TERMS.md) lives in `command.ts`; this module never
 * touches disk or the network.
 *
 * ## The drift heuristic (the one judgment call, settled here and unit-tested)
 *
 * A **concept-shaped candidate** is a phrase surfacing in a recent merge-commit
 * subject/body that reads like a *coined name*, not incidental prose — extracted by:
 *
 *   1. strip the conventional-commit type prefix (`feat(x): `, `fix: `, `docs(y): `),
 *   2. strip trailing issue/PR backlinks (`(#1726)`),
 *   3. slice out **quoted phrases** (`"split serving"`, from subject + body) and the
 *      **2–3-word windows of the subject** (the lever/model-phrase shape an author
 *      reaches for when *naming a concept*), dropping filler-bounded and nested windows.
 *      Bodies are prose, so only their quoted phrases are read — n-gramming a body would
 *      drown the signal.
 *
 * A candidate is **drift** iff its normalized form is NOT already covered by a
 * declared TERMS.md term (case/whitespace-insensitive, substring-tolerant so
 * "split release" matches a "split release/kill" term row).
 *
 * The heuristic is deliberately **recall-biased and cheap**: it prefers surfacing a
 * borderline phrase over missing a real coinage, because ADR 0128 makes a sweep hit a
 * *filed `status:needs-triage` issue*, never a blocked merge — a false positive costs
 * a triage glance, not a merge round-trip. Precision lives downstream in triage, not
 * here. Commit lines from `docs(glossary)` / `docs(decisions)` merges are dropped
 * before extraction: those are the routed surfaces prong (c) and the ADR flow already
 * cover, so re-surfacing them would be pure noise.
 */

/** A conventional-commit type this sweep treats as an already-routed glossary surface. */
const ROUTED_COMMIT_SCOPES = ["glossary", "decisions"] as const;

/** Conventional-commit prefix, e.g. `feat(cf-utils): ` or `docs: ` — captured to read its scope. */
const COMMIT_PREFIX_RE = /^(?<type>\w+)(?:\((?<scope>[^)]*)\))?!?:\s*/;

/** Trailing `(#1726)` / `(#1726) (#1733)` issue-or-PR backlinks. */
const BACKLINK_RE = /\s*\(#\d+\)/g;

/** A double-quoted phrase — the strongest "this is a coined name" signal. */
const QUOTED_RE = /"([^"]{2,60})"/g;

/** A word-token in a phrase window: a lowercase/hyphenated word (≥2 chars). */
const WORD_RE = /\b[a-z][a-z-]+\b/g;

/**
 * Function/filler words a coined concept phrase rarely starts or ends with. A window
 * whose first OR last token is one of these is dropped: it is almost always incidental
 * prose ("add the", "for releases") rather than a name. This trims the n-gram over-
 * generation without touching real coinages (a name like "kill switch" / "split serving"
 * neither opens nor closes on a stopword). Kept small and boundary-only on purpose —
 * over-pruning would cost recall, which ADR 0128 protects (a miss is worse than a noisy
 * file). NOT a general stoplist; just the commit-prose boundary words.
 */
const BOUNDARY_STOPWORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"of",
	"for",
	"to",
	"in",
	"on",
	"with",
	"into",
	"add",
	"adds",
	"added",
	"make",
	"makes",
	"use",
	"uses",
	"this",
	"that",
	"its",
	"is",
	"be",
	"no",
	"not",
	"real",
	"true",
	"new",
]);

const isFillerWindow = (gram: string): boolean => {
	const words = gram.split(" ");
	const first = words[0];
	const last = words[words.length - 1];
	return (
		(first !== undefined && BOUNDARY_STOPWORDS.has(first)) ||
		(last !== undefined && BOUNDARY_STOPWORDS.has(last))
	);
};

/** The n-gram window bounds — a coinage is a 2–3-word phrase ("split serving", "kill
 * switch", "ambient discovery", "effective serving model"). Bounded at 3, not 4: 4-word
 * windows are almost entirely a real 2-gram plus incidental prose, the dominant noise
 * source in a merge-subject sweep. */
const MIN_NGRAM = 2;
const MAX_NGRAM = 3;

/**
 * Every 2–3-word contiguous window over the lowercase word-tokens of `text`. Yields
 * OVERLAPPING windows — so a coined phrase ("kill switch") nested inside a longer run
 * ("true kill switch") still surfaces. Recall-biased on purpose (ADR 0128: a false
 * positive is a triage glance, not a blocked merge).
 */
const wordNgrams = (text: string): ReadonlyArray<string> => {
	const words = [...text.matchAll(WORD_RE)].map((m) => m[0].toLowerCase());
	const grams: Array<string> = [];
	for (let n = MIN_NGRAM; n <= MAX_NGRAM; n++) {
		for (let i = 0; i + n <= words.length; i++) {
			grams.push(words.slice(i, i + n).join(" "));
		}
	}
	return grams;
};

/** A single merge-commit line as gathered from `git log --first-parent`. */
export interface MergeLine {
	/** The commit subject (first line), e.g. `feat(cf-utils): model the real release lever … (#1733)`. */
	readonly subject: string;
	/** Optional body text (lines after the subject), where a longer coinage may appear. */
	readonly body?: string | undefined;
}

/** One drift candidate: the phrase and the merge subject that surfaced it (for the filed report). */
export interface DriftCandidate {
	/** The normalized concept phrase, e.g. `split serving`. */
	readonly phrase: string;
	/** The merge subject the phrase came from — the evidence line for triage. */
	readonly source: string;
}

/** Normalize a phrase/term for comparison: lowercase, collapse internal whitespace, trim. */
export const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Parse the declared term set out of `.glossary/TERMS.md`. Terms live in the first
 * `|`-column of the `| Term | Definition | Not |` tables; a cell may carry synonyms as
 * `sözlük (sozluk)` or `funnel / conversion funnel`, which we split into each alias so
 * "conversion funnel" and "funnel" both count as known. Header rows (`Term`) and the
 * `|---|` separators are skipped. Pure over the file text.
 */
export const parseKnownTerms = (termsMd: string): ReadonlySet<string> => {
	const known = new Set<string>();
	for (const raw of termsMd.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		if (!line.startsWith("|")) continue;
		if (/^\|[\s:|-]+\|?$/.test(line)) continue; // separator row |---|---|
		const firstCell = line.split("|")[1]?.trim() ?? "";
		if (firstCell === "" || firstCell.toLowerCase() === "term") continue;
		// A cell like `funnel / conversion funnel` or `sözlük (sozluk)` carries aliases.
		for (const alias of splitAliases(firstCell)) {
			const n = normalize(alias);
			if (n !== "") known.add(n);
		}
	}
	return known;
};

/** Split a term cell into its aliases on ` / ` and parenthetical `(...)` forms. */
const splitAliases = (cell: string): ReadonlyArray<string> => {
	const out: Array<string> = [];
	// `funnel / conversion funnel` → two aliases.
	for (const part of cell.split(" / ")) {
		// `sözlük (sozluk)` → both `sözlük` and `sozluk`.
		const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(part.trim());
		if (paren?.[1] !== undefined && paren?.[2] !== undefined) {
			out.push(paren[1], paren[2]);
		} else {
			out.push(part);
		}
	}
	return out;
};

/**
 * Extract concept-shaped candidate phrases from one merge line. Drops routed-surface
 * commits (`docs(glossary)`/`docs(decisions)`) entirely, strips the commit prefix and
 * backlinks, then pulls candidates from TWO sources with deliberately different reach:
 *
 * - **n-gram windows come from the SUBJECT only.** A commit subject is a *title* — an
 *   author names what they shipped tersely there, so its 2–4-word windows are dense with
 *   coinages and sparse with prose. A commit BODY is paragraph prose (a `docs(patterns)`
 *   body alone yields ~1000 incidental bigrams); n-gramming it drowns the signal and makes
 *   the filed issue useless to triage. So bodies are NOT n-grammed.
 * - **quoted phrases come from subject + body.** A `"quoted phrase"` anywhere is an
 *   explicit "this is a coined name" signal an author opted into, so it is worth reading
 *   out of the body too — it is high-precision by construction.
 */
export const extractCandidates = (line: MergeLine): ReadonlyArray<string> => {
	const m = COMMIT_PREFIX_RE.exec(line.subject);
	const scope = m?.groups?.scope ?? "";
	if (ROUTED_COMMIT_SCOPES.some((s) => scope.includes(s))) return [];

	const subject = stripPrefixAndLinks(line.subject);
	const quotable = `${subject} ${line.body ?? ""}`;
	const phrases = new Set<string>();

	for (const q of quotable.matchAll(QUOTED_RE)) {
		const n = normalize(q[1] ?? "");
		if (n.includes(" ")) phrases.add(n); // a quoted single word is too noisy
	}
	for (const gram of wordNgrams(subject)) {
		if (!isFillerWindow(gram)) phrases.add(gram);
	}
	// Per-merge superstring collapse: if two surfaced phrases nest ("ambient discovery"
	// ⊂ "ambient discovery delete"), keep only the shorter, atomic coinage. Without this
	// one concept fans out into every overlapping window it appears in — pure triage noise.
	return dropSuperstrings([...phrases]);
};

/** Drop any phrase that strictly contains another phrase in the same set (keep the shorter). */
const dropSuperstrings = (phrases: ReadonlyArray<string>): ReadonlyArray<string> =>
	phrases.filter((p) => !phrases.some((other) => other !== p && p.includes(other)));

/** Strip the conventional-commit prefix and trailing backlinks from a subject. */
const stripPrefixAndLinks = (subject: string): string =>
	subject.replace(COMMIT_PREFIX_RE, "").replace(BACKLINK_RE, "");

/**
 * Decide which candidate phrases across the merge window are drift — i.e. NOT already
 * covered by a known term. Coverage is substring-tolerant in BOTH directions so a
 * candidate `split serving` matches a `split release/kill` term row's `split` sense
 * only when one contains the other as a whole normalized substring; this errs toward
 * *suppressing* a candidate when the vocabulary already names it (fewer false files),
 * while still surfacing a genuinely new phrase. De-duplicated by phrase, keeping the
 * first source line as the evidence.
 */
export const findDrift = (
	lines: ReadonlyArray<MergeLine>,
	known: ReadonlySet<string>,
): ReadonlyArray<DriftCandidate> => {
	const seen = new Map<string, DriftCandidate>();
	for (const line of lines) {
		for (const phrase of extractCandidates(line)) {
			if (seen.has(phrase)) continue;
			if (isKnown(phrase, known)) continue;
			seen.set(phrase, {phrase, source: line.subject});
		}
	}
	return [...seen.values()];
};

/** A phrase is known iff it equals, contains, or is contained by any declared term. */
const isKnown = (phrase: string, known: ReadonlySet<string>): boolean => {
	for (const term of known) {
		if (term === phrase) return true;
		if (term.includes(phrase) || phrase.includes(term)) return true;
	}
	return false;
};

/**
 * Render the sweep verdict for humans (stdout / a workflow log). A clean sweep is an
 * explicit line, not silence, so "the sweep ran and found nothing" is distinguishable
 * from "the sweep didn't run" (ADR 0092 §1 — emit what you scanned).
 */
export const renderReport = (
	candidates: ReadonlyArray<DriftCandidate>,
	windowSize: number,
): string => {
	if (candidates.length === 0) {
		return `glossary-drift: swept ${windowSize} recent merge(s) — no candidate concept-level drift vs .glossary/TERMS.md`;
	}
	const lines = candidates.map((c) => `  • ${c.phrase}\n      ↳ from: ${c.source}`);
	return (
		`glossary-drift: ${candidates.length} candidate concept-level drift phrase(s) ` +
		`across ${windowSize} recent merge(s), not covered by .glossary/TERMS.md:\n${lines.join("\n")}`
	);
};

/**
 * Render the body of the `status:needs-triage` issue the sweep files on drift — the
 * `report` skill's five-section, type-blind intake template (`skills/report/SKILL.md`).
 * Kept in the pure core so the exact filed text is unit-testable without a network call.
 */
export const renderIssueBody = (
	candidates: ReadonlyArray<DriftCandidate>,
	windowSize: number,
): string => {
	const observed = candidates.map((c) => `- \`${c.phrase}\` — surfaced by: ${c.source}`).join("\n");
	return [
		"## What I was doing",
		`The periodic glossary-drift sweep (ADR 0128 prong (b), \`pipeline-cli glossary-drift\`) ran over the last ${windowSize} merges to \`main\`.`,
		"",
		"## What I observed",
		`${candidates.length} concept-shaped phrase(s) surfaced in recent merge subjects/bodies that are **not** covered by any declared term in \`.glossary/TERMS.md\`:`,
		"",
		observed,
		"",
		"These read like coined vocabulary an author named while shipping a regular code PR — the un-routed class the coining hook (#1747) and the `review-code` Step 3c structural gate cannot see (the #1726 release-lever redefinition is the grounded exemplar).",
		"",
		"## Why it matters",
		"A concept that ships un-glossaried drifts: the same idea gets named three different ways across the codebase (the one-concept-named-four-ways drift, #851 / ADR 0099). Each surfaced phrase is either a real term to add to `.glossary/TERMS.md`, or a false positive to dismiss — triage's call.",
		"",
		"## Pointers",
		"- Register to update: `.glossary/TERMS.md`.",
		"- The sweep: `packages/pipeline-cli/src/tools/glossary-drift/`, scheduled by `.github/workflows/glossary-drift.yml`.",
		"- Decision: [ADR 0128](.decisions/0128-glossary-concept-trigger-off-the-gate.md).",
		"- The glossary skill that does the incremental update: `claude-plugins/kampus-pipeline/skills/glossary/SKILL.md`.",
		"",
		"## Suggested next step (non-binding)",
		"For each phrase, decide add-to-TERMS vs dismiss-as-noise; for real terms, run the `glossary` skill to write the canonical definition. This is a *guess* — a phrase may be incidental prose the recall-biased heuristic over-surfaced.",
	].join("\n");
};
