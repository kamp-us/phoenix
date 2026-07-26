/**
 * `drive-issue` type routing — the pure, IO-free decision that turns the Classify stage's
 * `type:*` label into the agent lane a dispatch may enter (issue #4113).
 *
 * The executor `.claude/workflows/drive-issue.js` used to classify by type and then throw the
 * answer away: `klass.type` reached exactly one log line and the sole branch was
 * `if (klass.isEpic)`. So routing was binary — epic → planner, **everything else → the coder**
 * — and a `type:decision` issue landed in a coder lane *by construction*. A coder handed a
 * decision implements an answer to the very question the issue exists to settle, and whatever
 * it invents becomes the de-facto ruling with no ADR authorizing it (#4045).
 *
 * This module is that routing decision as a single tested unit. The workflow inlines the same
 * table because a workflow script — top-level `return`, injected globals — is not importable;
 * this module is its canonical mirror and the one that carries the unit test (the
 * `post-build.ts` / `resume-cap.ts` sibling shape).
 *
 * **The rule, in one line:** every one of the six canonical types names its lane explicitly,
 * and anything else — an absent, unknown, multiple or unparseable type — is **unroutable** and
 * aborts the dispatch. Fail-closed here means *refuse to dispatch*, never "dispatch the coder
 * anyway": the coder is the lane with a side effect (a branch, a PR, a shipped position), so a
 * default that falls into it converts every classification failure into shipped work.
 *
 * The guard is deliberately at **lane entry**, not at merge. A merge-path check on the linked
 * issue's type would be a direction gate on finished work, which founder no-go #3909 forbids
 * outright (#3947: "Nothing changes at merge").
 */

/** The agent lane a routable issue type dispatches into. */
export type DispatchLane = "planner" | "adr" | "coder";

/**
 * The lane for each of the six canonical `type:*` labels (the `triage` taxonomy). Every type is
 * a named entry — there is no default arm, which is what makes an unlisted type unroutable
 * rather than silently a coder.
 *
 * The two non-obvious entries:
 *
 * - **`decision` → `adr`.** A decision's deliverable is a recorded choice, not a diff. It routes
 *   to the `adr` agent, which wraps the adr skill end to end and adds exactly one
 *   `.decisions/NNNN-slug.md`.
 * - **`investigation` → `coder`, named rather than fallen-through.** An investigation's
 *   deliverable is a diagnosis, and `write-code` is the skill that owns *both* of its outcomes:
 *   the residue path (closing comment + `report`) and the bounded collapse into a single PR when
 *   the diagnosis lands on a trivial fix (ADR 0070, the four AND-ed bounds in
 *   `gh-issue-intake-formats.md` §8). So the coder lane is a defensible route for an
 *   investigation in a way it is never defensible for a decision — but it is written here as an
 *   explicit entry so it is a *choice*, re-openable by editing this table, not the residue of a
 *   missing branch.
 */
const LANE_BY_TYPE = {
	epic: "planner",
	decision: "adr",
	investigation: "coder",
	feature: "coder",
	chore: "coder",
	bug: "coder",
} as const satisfies Record<string, DispatchLane>;

/** One of the six canonical types, bare (no `type:` prefix). */
export type KnownIssueType = keyof typeof LANE_BY_TYPE;

/** The same six as whole label names — what `vocabulary-preflight` asserts the repo actually has. */
export const ISSUE_TYPE_LABELS: ReadonlyArray<string> = Object.keys(LANE_BY_TYPE).map(
	(type) => `type:${type}`,
);

const REASON_BY_TYPE: Record<KnownIssueType, string> = {
	epic: "an epic's deliverable is a planned child ledger, not a diff",
	decision:
		"a decision's deliverable is a recorded ADR, not a diff — a coder would implement an answer to the question the issue exists to settle (#4045)",
	investigation:
		"an investigation's deliverable is a diagnosis, and write-code owns both its residue path and its bounded collapse to one PR (ADR 0070) — a named route, not a fall-through",
	feature: "a directly implementable capability — the implement-and-PR path",
	chore: "no behavior change, but still a diff — the implement-and-PR path",
	bug: "a nameable fix — the implement-and-PR path",
};

/**
 * The routing decision. A discriminated union so an unroutable classification cannot be read as
 * if it named a lane: there is no `lane` field to reach for on the `routed: false` arm.
 */
export type TypeRoute =
	| {
			readonly routed: true;
			readonly lane: DispatchLane;
			readonly type: KnownIssueType;
			readonly reason: string;
	  }
	| {
			readonly routed: false;
			/** The type as read (normalized), or `""` when nothing readable came back. */
			readonly type: string;
			readonly reason: string;
	  };

/**
 * Normalize whatever the Classify stage returned into a bare canonical type word: lowercase,
 * trimmed, stripped of surrounding backticks/quotes and of the `type:` prefix. Read tolerantly,
 * decide strictly — the tolerance only ever maps a *recognizable* spelling onto a known word;
 * anything the table does not name still falls through to unroutable. A non-string (the stage
 * returned a number, an object, nothing) normalizes to `""`.
 */
export const normalizeIssueType = (raw: unknown): string => {
	if (typeof raw !== "string") return "";
	return raw
		.trim()
		.toLowerCase()
		.replace(/^[`'"\s]+|[`'"\s]+$/g, "")
		.replace(/^type:\s*/, "")
		.trim();
};

/**
 * Route an issue by its `type:*` label. Returns the named lane for one of the six canonical
 * types; returns the `routed: false` arm — the dispatch-aborting state — for an absent, empty,
 * unknown, or multi-valued type. **Never** returns a coder lane it was not told to.
 */
export const routeIssueType = (rawType: unknown): TypeRoute => {
	const type = normalizeIssueType(rawType);
	if (type === "") {
		return {
			routed: false,
			type: "",
			reason:
				"no readable `type:*` label on the issue — fail-closed: an unclassifiable issue is not a licence to dispatch a coder",
		};
	}
	if (!Object.hasOwn(LANE_BY_TYPE, type)) {
		return {
			routed: false,
			type,
			reason: `unroutable issue type \`type:${type}\` — not one of the six canonical types (bug, feature, chore, decision, investigation, epic); fail-closed rather than defaulting to a coder lane`,
		};
	}
	const known = type as KnownIssueType;
	return {routed: true, lane: LANE_BY_TYPE[known], type: known, reason: REASON_BY_TYPE[known]};
};

/** The structured, resumable terminal result an unroutable classification aborts to. */
export interface UnroutableResult {
	readonly unroutable: true;
	readonly issue: number;
	readonly type: string;
	readonly reason: string;
}

/**
 * Build the terminal result for an unroutable type. Distinct from every other terminal shape the
 * flow returns (`skipped`, `backedOff`, `frozen`, `aborted`) so a driving session can tell
 * "this issue's type does not name a lane" apart from a lost claim or a dead subagent, and can
 * resume the run after a human fixes the label. Accepts only the unroutable arm, so a routable
 * decision can never be turned into an abort by a mis-call.
 */
export const unroutableResult = (
	issue: number,
	route: Extract<TypeRoute, {routed: false}>,
): UnroutableResult => ({
	unroutable: true,
	issue,
	type: route.type,
	reason: route.reason,
});
