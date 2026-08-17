/**
 * The two GitHub reads this gate needs that no shipped module already makes, plus the repo-file probe
 * `MISSING_CONTAINMENT` rests on. Everything else is imported (`io/issues.ts`, `build/target.ts`).
 *
 * Both reads keep the package's two standing disciplines, which is why they are here rather than
 * inline in a verb:
 *
 * - **A shape that is not what was asked for is a failure, never an empty result.** A sub-issue list
 *   that decodes to something else fails; it never reads back as "this epic has no children", which
 *   would turn a broken read into a clean zero-scope refusal about a real ledger.
 * - **Absence is decided by HTTP status, never by matching text against `gh`'s stderr.** v1 used
 *   `/404|not found/i.test(stderr)`, which reads an auth-hidden repo as a proven-absent issue.
 *
 * **Why the child read is not `getIssue`.** `IssueRecord` drops the payload's `assignees` key
 * entirely, and the distinction `UNVERIFIABLE_ASSIGNEE` rests on is exactly *the key was not there* —
 * a fact no shape that omits the field can carry. {@link ChildPayload} is that shape: a sibling of
 * `io/issues.ts`'s readers, decoded from the same endpoint, one fetch per child.
 */

import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {absent, type Existence, httpStatusOf, pagedJson, present, unknown} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";
import type {CycleDoc} from "./model.ts";

/** The cycle doc the containment class is gated on, at the target repository's root. */
export const CYCLE_DOC_PATH = "product-development-cycle.md";

/** One native sub-issue link: the child's number plus the open/closed facts the payload carries. */
export interface SubIssueLink {
	readonly number: number;
	readonly state: "open" | "closed";
	readonly stateReason: string | null;
}

/**
 * The epic's children, from the **native sub-issue link list**, paginated in full.
 *
 * Typed-JSON decoded rather than `--jq`: `-r` errors mid-stream on a control character in a title and
 * reads back as an empty body, which for a child list is a false "no children".
 *
 * Each entry must carry a readable `state` — an entry without one fails the whole read rather than
 * defaulting to open, because a silently-defaulted state is exactly how `lane emit` booted closed
 * children as `queued` (#5746).
 */
export const listSubIssues = (
	repo: string,
	epic: number,
): Shell<Attempt<ReadonlyArray<SubIssueLink>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues/${epic}/sub_issues?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const pages = pagedJson(r.stdout);
		if (pages._tag === "Failure") return pages;
		const links: SubIssueLink[] = [];
		for (const page of pages.value) {
			const parsed = parseJson(page);
			if (!Array.isArray(parsed)) {
				return fail("`gh api` exited 0 but its output is not a list of sub-issues");
			}
			for (const value of parsed) {
				if (!isRecord(value) || typeof value.number !== "number") {
					return fail("`gh api` exited 0 but one entry is not a sub-issue");
				}
				if (value.state !== "open" && value.state !== "closed") {
					return fail(
						`\`gh api\` exited 0 but sub-issue #${value.number} carries no readable \`state\``,
					);
				}
				links.push({
					number: value.number,
					state: value.state,
					stateReason: typeof value.state_reason === "string" ? value.state_reason : null,
				});
			}
		}
		return ok(links);
	});

/** One child as the ledger reads it — labels, body, and the three-state assignee slot. */
export interface ChildPayload {
	readonly number: number;
	readonly labels: ReadonlyArray<string>;
	readonly body: string;
	readonly state: string;
	/** The observed logins, or `null` when the payload carried no `assignees` key at all. */
	readonly assignees: ReadonlyArray<string> | null;
	readonly assigneesObserved: boolean;
}

const toChildPayload = (value: unknown): ChildPayload | null => {
	if (!isRecord(value) || typeof value.number !== "number") return null;
	const names = Array.isArray(value.labels)
		? value.labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: null;
	if (names === null || names.includes(null)) return null;

	const observed = Object.hasOwn(value, "assignees") && Array.isArray(value.assignees);
	const logins = observed
		? (value.assignees as ReadonlyArray<unknown>).map((a) =>
				isRecord(a) && typeof a.login === "string" ? a.login : null,
			)
		: null;
	if (logins?.includes(null) === true) return null;

	return {
		number: value.number,
		labels: names as ReadonlyArray<string>,
		body: typeof value.body === "string" ? value.body : "",
		state: typeof value.state === "string" ? value.state : "",
		assignees: logins as ReadonlyArray<string> | null,
		assigneesObserved: observed,
	};
};

export const getChild = (repo: string, child: number): Shell<Existence<ChildPayload>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/issues/${child}`]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404
				? absent<ChildPayload>()
				: unknown<ChildPayload>(r.reason);
		}
		const payload = toChildPayload(parseJson(r.stdout));
		return payload === null
			? unknown<ChildPayload>("`gh api` exited 0 but its output is not an issue")
			: present(payload);
	});

/**
 * Whether the repository carries the cycle doc — three-valued, and the third value is the point.
 *
 * A probe that **failed** answers `unknown`, which puts `MISSING_CONTAINMENT` in the floor's
 * `skipped` array rather than evaluating it false. Folding `unknown` into `absent` is precisely v1's
 * bug: a transient failure silently switched the whole class off for a run.
 */
export const probeCycleDoc = (repo: string): Shell<CycleDoc> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/contents/${CYCLE_DOC_PATH}`]);
		if (r.ok) return "present" as const;
		return httpStatusOf(r.reason) === 404 ? ("absent" as const) : ("unknown" as const);
	});
