/**
 * The PURE parse/derive core of the pipeline feature — no network, no Effect, no
 * GitHub client. Everything here is a total function over plain data, so the
 * label/sub_issues/`## Dependencies` parsing is unit-testable against fixtures
 * without touching the wire (the I/O seam lives in `github.ts`).
 *
 * Reading stance is tolerant per `.claude/skills/gh-issue-intake-formats.md`:
 * recognize a section by shape, not exact whitespace; ignore what isn't modelled
 * rather than failing.
 */
import type {
	DependencyPhase,
	DependencyTopology,
	ParsedLabels,
	PipelinePriority,
	PipelineStatus,
	PipelineType,
	ReviewVerdicts,
} from "./schema.ts";

const STATUS_VALUES: ReadonlySet<string> = new Set([
	"needs-triage",
	"needs-info",
	"planned",
	"triaged",
]);
const TYPE_VALUES: ReadonlySet<string> = new Set([
	"feature",
	"chore",
	"bug",
	"decision",
	"investigation",
	"epic",
]);
const PRIORITY_VALUES: ReadonlySet<string> = new Set(["p0", "p1", "p2"]);

/**
 * Lift the `status:*` / `type:*` / `p*` typed fields out of a label-name list. A
 * namespace with no recognized label yields `null` (the issue simply doesn't
 * assert that field) — unknown labels are ignored, never an error. First match per
 * namespace wins; a well-formed issue carries at most one of each.
 */
export const parseLabels = (labels: ReadonlyArray<string>): ParsedLabels => {
	let status: PipelineStatus | null = null;
	let type: PipelineType | null = null;
	let priority: PipelinePriority | null = null;

	for (const raw of labels) {
		const label = raw.trim();
		if (status === null && label.startsWith("status:")) {
			const v = label.slice("status:".length);
			if (STATUS_VALUES.has(v)) status = v as PipelineStatus;
		} else if (type === null && label.startsWith("type:")) {
			const v = label.slice("type:".length);
			if (TYPE_VALUES.has(v)) type = v as PipelineType;
		} else if (priority === null && PRIORITY_VALUES.has(label)) {
			priority = label as PipelinePriority;
		}
	}

	return {status, type, priority};
};

/** Is this issue an epic? Carries the `type:epic` label. */
export const isEpic = (labels: ReadonlyArray<string>): boolean =>
	parseLabels(labels).type === "epic";

const PHASE_HEADING = /^#{2,4}\s*phase\s+(\d+)\b/i;
const REQUIRES_BLOCK = /requires:\s*([^)\n]*)/i;

/** Every `#NNN` reference in a string, in order. A fresh regex per call (no shared state). */
const issueRefs = (s: string): ReadonlyArray<number> => {
	const refs: number[] = [];
	for (const m of s.matchAll(/#(\d+)/g)) refs.push(Number(m[1]));
	return refs;
};

/**
 * Scan one phase bullet line for a `requires:` annotation and return the issue
 * numbers it names. `requires: #210, #104` → `[210, 104]`. No annotation → `[]`.
 * A `requires:` may name an issue outside the epic (a legitimate cross-epic edge);
 * this returns the raw referenced numbers and does not resolve them.
 */
const parseRequiresRefs = (line: string): ReadonlyArray<number> => {
	const block = REQUIRES_BLOCK.exec(line);
	const refs = block?.[1];
	return refs === undefined ? [] : issueRefs(refs);
};

/** The first `#NNN` on a bullet line is the line's subject issue; null if none. */
const parseSubjectRef = (line: string): number | null => {
	const [first] = issueRefs(line);
	return first ?? null;
};

/**
 * Parse an epic body's pinned `## Dependencies` section into the structured
 * topology — ordered phases (the sequential spine), each carrying its parallel
 * group of issue numbers, plus the flat set of `requires:` gating edges.
 *
 * Tolerant: a body with no `## Dependencies` section yields an empty topology
 * (`{phases: [], requires: []}`), never an error. Phase headings are matched by
 * shape (`### Phase N`, 2–4 hashes, case-insensitive); a bullet's subject issue is
 * its first `#NNN`, and a trailing `(requires: #X, #Y)` becomes one edge per ref.
 */
export const parseDependencies = (body: string | null | undefined): DependencyTopology => {
	const phases: DependencyPhase[] = [];
	const requires: {from: number; to: number}[] = [];
	if (!body) return {phases, requires};

	let current: {phase: number; issues: number[]} | null = null;

	for (const line of body.split(/\r?\n/)) {
		const heading = PHASE_HEADING.exec(line.trim());
		if (heading) {
			current = {phase: Number(heading[1]), issues: []};
			phases.push(current);
			continue;
		}
		if (!current) continue;

		const subject = parseSubjectRef(line);
		if (subject === null) continue;
		current.issues.push(subject);

		for (const ref of parseRequiresRefs(line)) {
			requires.push({from: subject, to: ref});
		}
	}

	return {phases, requires};
};

/**
 * The issue a PR closes, from a `Fixes #N` / `Closes #N` / `Resolves #N` annotation
 * in its body (the seam `write-code` writes and `review-code` relies on). Tolerant of
 * the verb's tense and the `(es|d)` suffixes; returns the first such reference, or
 * null if the body links no closing issue. A PR with no closing link surfaces no
 * verdict against any issue.
 */
export const parseLinkedIssue = (body: string | null | undefined): number | null => {
	if (!body) return null;
	const m = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)/i.exec(body);
	return m ? Number(m[1]) : null;
};

/** One PR comment reduced to what verdict resolution needs: its body + post time. */
export interface VerdictComment {
	readonly body: string;
	readonly createdAt: string;
}

/**
 * The canonical emphasis-tolerant marker matcher from
 * `.claude/skills/gh-issue-intake-formats.md` §5: an anchored, case-insensitive
 * first-line match with an optional leading `**` absorbing review-code's bolding.
 * `^\s*\**\s*` pins it to the start so a mid-body *quote* of a marker never
 * matches; only the literal `PASS`/`FAIL` tokens count, so the §6 `advisory` line
 * (a blocking-set PR) is deliberately not a verdict. One namespace per call.
 */
const verdictMatcher = (namespace: "code" | "doc"): RegExp =>
	new RegExp(`^\\s*\\**\\s*review-${namespace}:\\s*(PASS|FAIL)\\b`, "i");

const latestVerdict = (
	comments: ReadonlyArray<VerdictComment>,
	namespace: "code" | "doc",
): "PASS" | "FAIL" | null => {
	const matcher = verdictMatcher(namespace);
	let latest: {at: string; verdict: "PASS" | "FAIL"} | null = null;
	for (const c of comments) {
		const token = matcher.exec(c.body)?.[1];
		if (token === undefined) continue;
		if (latest === null || c.createdAt > latest.at) {
			latest = {at: c.createdAt, verdict: token.toUpperCase() as "PASS" | "FAIL"};
		}
	}
	return latest?.verdict ?? null;
};

/**
 * Resolve the latest review verdict per namespace from a PR's comments, mirroring
 * the `ship-it`/`write-code` resolution: anchored namespaced matchers that never
 * cross-match (a `review-code` scan ignores a `review-doc` marker and vice versa),
 * latest-wins by `createdAt`. A namespace with no marker yields `null` — the caller
 * distinguishes "open PR, no verdict yet" (awaiting review) from a real PASS/FAIL,
 * so an awaiting PR never shows a false verdict.
 *
 * Pure and total: empty input → `{code: null, doc: null}`; comment order is
 * irrelevant (the timestamp decides, not array position). No ACL author-gate here —
 * that is an I/O concern (it needs the repo collaborator API); this core resolves
 * the marker shape, the seam in `github.ts` decides whose comments to feed it.
 */
export const parseVerdict = (comments: ReadonlyArray<VerdictComment>): ReviewVerdicts => ({
	code: latestVerdict(comments, "code"),
	doc: latestVerdict(comments, "doc"),
});
