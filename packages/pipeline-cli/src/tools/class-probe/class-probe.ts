/**
 * `class-probe` pure core — the deterministic artifact-class classifier the reviewer
 * fan and ship-it Step 0 share, so `dispatched-gate == required-gate` holds by
 * construction rather than by two agents independently eyeballing the same prose.
 *
 * The classification RESULT was already regex-correct on `main`, yet PR #2430 still
 * missed: the reviewer read `.glossary/TERMS.md` as a doc surface and fanned only
 * `review-skill`, so a mixed has-skills + `.glossary/**` PR reached `ship-it` with an
 * empty `review-code` namespace and ship-it's fail-closed conjunction correctly refused
 * to enqueue (#2434). An LLM eyeball is not a probe. This core makes the probe
 * executable and unit-tested — `.glossary/** → has-code` is pinned, not inferred.
 *
 * Single source: the four `HAS_*_RE` regexes are NOT re-declared here — they are parsed
 * from `gh-issue-intake-formats.md` §CLASS, the one definition ship-it Step 0 and the
 * reviewer fan both re-resolve. There is no third copy to drift out of lockstep.
 */

/** The three artifact classes a PR diff can span — each maps to one `review-*` gate. */
export type ArtifactClass = "has-code" | "has-docs" | "has-skills";

/** The `review-*` verdict namespace a present class requires on the PR. */
export type ReviewNamespace = "review-code" | "review-doc" | "review-skill";

/** Canonical class → namespace map (one per present class: reviewer emits, ship-it requires). */
const NAMESPACE_OF: Readonly<Record<ArtifactClass, ReviewNamespace>> = {
	"has-code": "review-code",
	"has-docs": "review-doc",
	"has-skills": "review-skill",
};

/** Emit order — code, docs, skills — so output is stable regardless of file order. */
const CLASS_ORDER: ReadonlyArray<ArtifactClass> = ["has-code", "has-docs", "has-skills"];

/**
 * The four §CLASS probe regexes, as raw ERE strings. `docs` is the carve-then-test pair:
 * a file is a doc iff it does NOT match `docsExclude` (the code/skills/`.glossary`
 * carve-out) AND matches `docs`.
 */
export interface ClassProbes {
	readonly hasCode: string;
	readonly hasSkills: string;
	readonly docsExclude: string;
	readonly docs: string;
}

/**
 * Fail-closed defaults, byte-identical to ship-it Step 0 / the reviewer fan's
 * `reresolve_re` fallbacks: a match probe defaults to `.` (every path matches ⇒ the
 * class fires), and the docs carve-out defaults to the never-match sentinel `$^` (carve
 * out nothing ⇒ every path reaches the doc test). An unreadable/incomplete §CLASS thus
 * over-dispatches gates — never silently skips one.
 */
export const FAILCLOSED_PROBES: ClassProbes = {
	hasCode: ".",
	hasSkills: ".",
	docsExclude: "$^",
	docs: ".",
};

/**
 * Parse the canonical `HAS_*_RE='…'` lines out of `gh-issue-intake-formats.md` §CLASS.
 * Matches only the single-quoted canonical assignment (`NAME='…'`), never the
 * double-quoted `reresolve_re` re-assignment lines below it. A missing line falls back to
 * its fail-closed default — the source is single, so this only bites on a truncated read.
 */
export const parseClassProbes = (formatsText: string): ClassProbes => {
	const read = (name: string, fallback: string): string => {
		const m = formatsText.match(new RegExp(`^${name}='([^']*)'`, "m"));
		return m?.[1] ?? fallback;
	};
	return {
		hasCode: read("HAS_CODE_RE", FAILCLOSED_PROBES.hasCode),
		hasSkills: read("HAS_SKILLS_RE", FAILCLOSED_PROBES.hasSkills),
		docsExclude: read("HAS_DOCS_EXCLUDE_RE", FAILCLOSED_PROBES.docsExclude),
		docs: read("HAS_DOCS_RE", FAILCLOSED_PROBES.docs),
	};
};

/**
 * Compile an ERE string to a matcher, falling back to `onUncompilable` when it won't
 * compile — a broken probe must never silently match nothing (fail-open). For a positive
 * probe the fallback is match-everything; for the docs carve-out it is match-nothing (so
 * the carve excludes nothing and every path reaches the doc test).
 */
const matcher = (
	re: string,
	onUncompilable: (path: string) => boolean,
): ((path: string) => boolean) => {
	try {
		const compiled = new RegExp(re);
		return (path) => compiled.test(path);
	} catch {
		return onUncompilable;
	}
};

/**
 * Classify a changed-file set into the artifact classes it spans (the reviewer's fan
 * set, identical to ship-it's required-namespace set for the same diff). Mirrors the
 * §CLASS bash exactly: has-code / has-skills are direct matches; has-docs is
 * carve-then-test (`grep -Ev exclude | grep -Eq docs`).
 */
export const classify = (
	files: ReadonlyArray<string>,
	probes: ClassProbes,
): ReadonlyArray<ArtifactClass> => {
	const isCode = matcher(probes.hasCode, () => true);
	const isSkills = matcher(probes.hasSkills, () => true);
	const isExcluded = matcher(probes.docsExclude, () => false);
	const isDocPath = matcher(probes.docs, () => true);

	const present = new Set<ArtifactClass>();
	if (files.some(isCode)) present.add("has-code");
	if (files.some(isSkills)) present.add("has-skills");
	if (files.some((f) => !isExcluded(f) && isDocPath(f))) present.add("has-docs");

	return CLASS_ORDER.filter((c) => present.has(c));
};

/** The `review-*` namespaces a diff requires — one per present class, in canonical order. */
export const requiredNamespaces = (
	classes: ReadonlyArray<ArtifactClass>,
): ReadonlyArray<ReviewNamespace> => classes.map((c) => NAMESPACE_OF[c]);
