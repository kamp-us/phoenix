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
 * reviewer fan both re-resolve. There is no third copy to drift out of lockstep. The
 * additive `UI_RE` (has-ui → the `review-design` gate) is parsed the same way but from its
 * own single source, `ship-it/SKILL.md` (§CLASS keeps it there deliberately, never in
 * §CLASS itself) — folding it in here is what makes review-design a deterministic probe
 * output the reviewer fan dispatches rather than an eyeball it can skip (#2485/#2483).
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
 *
 * No-class fail-closed (#2765): a changed file matching NONE of the three class probes —
 * root-level executable build/lint tooling outside the code roots (`biome-plugins/**`,
 * `biome.jsonc`, `turbo.json`, `pnpm-workspace.yaml`, …) — used to leave the diff spanning
 * zero classes, so ship-it required zero gates and it could merge un-reviewed (PR #2760 was
 * safe only by carrying an unrequired review-code PASS). Such a file now rides **has-code**
 * (review-code, the general logic gate), making the invalid "non-empty diff, zero required
 * gates" state unrepresentable. An empty diff still spans no class — nothing to gate. This
 * is not a fourth class or a widened regex (that regex single-source is #2761); it is the
 * fail-closed default of the same ADR 0092 idiom the FAILCLOSED_PROBES over-dispatch uses.
 */
export const classify = (
	files: ReadonlyArray<string>,
	probes: ClassProbes,
): ReadonlyArray<ArtifactClass> => {
	const isCode = matcher(probes.hasCode, () => true);
	const isSkills = matcher(probes.hasSkills, () => true);
	const isExcluded = matcher(probes.docsExclude, () => false);
	const isDocPath = matcher(probes.docs, () => true);
	const isDoc = (f: string): boolean => !isExcluded(f) && isDocPath(f);
	const isClassified = (f: string): boolean => isCode(f) || isSkills(f) || isDoc(f);

	const present = new Set<ArtifactClass>();
	if (files.some(isCode) || files.some((f) => !isClassified(f))) present.add("has-code");
	if (files.some(isSkills)) present.add("has-skills");
	if (files.some(isDoc)) present.add("has-docs");

	return CLASS_ORDER.filter((c) => present.has(c));
};

/** The `review-*` namespaces a diff requires — one per present class, in canonical order. */
export const requiredNamespaces = (
	classes: ReadonlyArray<ArtifactClass>,
): ReadonlyArray<ReviewNamespace> => classes.map((c) => NAMESPACE_OF[c]);

/**
 * The additive UI gate — required *alongside* the class gate(s), never as a class of its
 * own (§CLASS). A UI-affecting diff must reach ship-it with a `review-design` marker present.
 */
export const DESIGN_NAMESPACE = "review-design" as const;

/**
 * Fail-closed UI probe: `.` ⇒ every path is UI-affecting ⇒ has-ui, so an unreadable/incomplete
 * `UI_RE` demands review-design rather than silently dropping the gate (mirrors ship-it Step 0 /
 * the reviewer's `ui_reresolve` fail-closed `has-ui`).
 */
export const FAILCLOSED_UI_RE = ".";

/**
 * Fail-closed UI carve-out: `$^` (end-anchor before start-anchor ⇒ never matches) ⇒ carve out
 * NOTHING, so an unreadable/incomplete `UI_EXCLUDE_RE` leaves every apps/web/src path (tests
 * included) reaching the UI test ⇒ demand review-design. Mirrors §CLASS's `HAS_DOCS_EXCLUDE_RE`
 * fail-closed sentinel — the safe direction is over-gate, never silently exempt.
 */
export const FAILCLOSED_UI_EXCLUDE_RE = "$^";

/**
 * Parse the canonical `UI_RE='…'` / `UI_EXCLUDE_RE='…'` lines out of `ship-it/SKILL.md` — the
 * single source for the additive has-ui/review-design gate (§CLASS keeps both in ship-it, not in
 * §CLASS itself). A missing line falls back to its fail-closed default; the source is single, so
 * this only bites on a truncated read. (`^UI_RE=` does not match the `UI_EXCLUDE_RE=` line — the
 * fourth char diverges — so the two never cross-capture.)
 */
export const parseUiProbe = (shipItText: string): string =>
	shipItText.match(/^UI_RE='([^']*)'/m)?.[1] ?? FAILCLOSED_UI_RE;

export const parseUiExclude = (shipItText: string): string =>
	shipItText.match(/^UI_EXCLUDE_RE='([^']*)'/m)?.[1] ?? FAILCLOSED_UI_EXCLUDE_RE;

/**
 * Is the diff UI-affecting (has-ui)? Carve-then-test, mirroring §CLASS's has-docs probe: a file
 * counts only if it is NOT a test/spec (`UI_EXCLUDE_RE`) AND matches `UI_RE`. A non-visual
 * `apps/web/src/*.ts` still counts — deliberate, not a bug to eyeball away: ship-it requires
 * review-design on exactly this predicate, so the fan must dispatch it on exactly this predicate
 * or the PR deadlocks on a phantom-empty review-design namespace (#2485/#2483). A `.tsx`/`.css`
 * OUTSIDE apps/web/src is not has-ui — the scope is `^apps/web/src/` only, so the require predicate
 * never exceeds review-design's dispatch/off-ramp (#2470). The carve-out (#3071) exempts an
 * all-test/spec src diff — `*.test.tsx` / `*.spec.ts` render no surface, so a required review-design
 * on them could only ever no-op PASS (the #3046/#3047 ship stall); a real component or a mixed
 * component+test diff survives the carve and STILL gates. Fail-closed: an uncompilable UI_RE matches
 * every path ⇒ has-ui; an uncompilable exclude carves nothing ⇒ still has-ui.
 */
export const isUiAffecting = (
	files: ReadonlyArray<string>,
	uiRe: string,
	uiExclude: string,
): boolean => {
	const isUi = matcher(uiRe, () => true);
	const isTestOrSpec = matcher(uiExclude, () => false);
	return files.some((f) => !isTestOrSpec(f) && isUi(f));
};
