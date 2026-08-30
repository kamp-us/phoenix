/**
 * GitHub's **native** relationship endpoints: the sub-issue link and the two issue-dependency
 * lists. The frontier's topology is stored here rather than in a map body, so this is the one path
 * to it — a second path is what let v1's prose topology drift from the graph it described.
 *
 * The `issues.ts` disciplines hold unchanged: REST and never GraphQL, every list read paged, absent
 * split from unreadable through {@link Existence}, and a shape that is not what was asked for
 * treated as a failure rather than an empty result.
 *
 * <!-- anchor: 404-IS-A-VERDICT --> **A 404 on a dependency read is a verdict about the issue, not
 * about its edges.** These endpoints answer `200 []` for a real issue with no edges and `404` for an
 * issue that does not exist, so the two are distinguishable — but only if existence is established
 * separately. A caller that read `[]` and reported "no blocking edges" without knowing the issue
 * exists would print a proven negative over zero scope (ADR 0092, #4752), which is why every read
 * here answers `Absent` on a 404 instead of an empty list.
 *
 * <!-- anchor: EDGE-BODY-TAKES-AN-INTERNAL-ID --> **Both POST bodies take the target's internal
 * `id`, not its issue number**, and the sub-issue key is the singular `sub_issue_id`. Passing a
 * number silently addresses a different issue, so the writes below take an id and the caller resolves
 * it with `getIssue` rather than interpolating a number.
 *
 * **Pagination is load-bearing, not hygiene.** An unpaginated `blocked_by` read returns a plausible
 * first page, so a frontier that "looks clear" at 30 edges would be reported clear with nothing
 * marking it wrong — the fail-open direction.
 */
import {Effect} from "effect";
import {
	authed,
	authedExistence,
	existenceOf,
	pagedExistence,
	refusalText,
	restCall,
} from "./gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {type Existence, present, unknown} from "./issues.ts";
import {isRecord} from "./json.ts";

/** The issue numbers in a paged list response, or the reason the entries are not that. */
const issueNumbers = (entries: ReadonlyArray<unknown>): Attempt<ReadonlyArray<number>> => {
	const numbers: number[] = [];
	for (const value of entries) {
		if (!isRecord(value) || typeof value.number !== "number") {
			return fail("GitHub answered 200 but one entry carries no issue number");
		}
		numbers.push(value.number);
	}
	return ok(numbers);
};

const listRelation = (repo: string, path: string): Shell<Existence<ReadonlyArray<number>>> =>
	authedExistence((token) =>
		Effect.gen(function* () {
			const read = yield* pagedExistence(token, `repos/${repo}/${path}`);
			if (read._tag !== "Present") return read;
			if (!read.value.exhausted) {
				return unknown<ReadonlyArray<number>>(`${path} was not read to its end`);
			}
			const numbers = issueNumbers(read.value.entries);
			return numbers._tag === "Failure"
				? unknown<ReadonlyArray<number>>(numbers.reason)
				: present(numbers.value);
		}),
	);

/** The map's children. `200 []` is a proven-empty child set; a non-404 error is `Unknown`. */
export const subIssues = (repo: string, parent: number): Shell<Existence<ReadonlyArray<number>>> =>
	listRelation(repo, `issues/${parent}/sub_issues`);

/** What a ticket waits on. */
export const blockedBy = (repo: string, issue: number): Shell<Existence<ReadonlyArray<number>>> =>
	listRelation(repo, `issues/${issue}/dependencies/blocked_by`);

/** What a ticket gates. */
export const blocking = (repo: string, issue: number): Shell<Existence<ReadonlyArray<number>>> =>
	listRelation(repo, `issues/${issue}/dependencies/blocking`);

/** What an edge write needs to know about its target. */
export interface EdgeTarget {
	/** The internal `id` — the value both POST bodies take, never the issue number. */
	readonly id: number;
	/**
	 * <!-- anchor: A-PR-RESOLVES-PRESENT-HERE --> `repos/{o}/{r}/issues/<n>` serves **pull requests
	 * too**, answering 200 with an `id` and a `pull_request` object. So a caller that reads only the
	 * id cannot tell an issue from a PR, and the 404 arm it would refuse a bad target on never fires
	 * for one (#6728). ADR 0301 rules the case — a blocking PR is named in the graph by the issue its
	 * merge closes — and this field is what lets a caller apply it.
	 */
	readonly pullRequest: boolean;
}

/** The target as an edge write sees it: the id to POST, and whether it is a pull request. */
export const edgeTarget = (repo: string, issue: number): Shell<Existence<EdgeTarget>> =>
	authedExistence((token) =>
		restCall(token, {method: "GET", path: `repos/${repo}/issues/${issue}`}).pipe(
			Effect.map((outcome) =>
				existenceOf(outcome, (body) => {
					const id = isRecord(body) ? body.id : undefined;
					return typeof id === "number"
						? ok({id, pullRequest: isRecord(body) && body.pull_request !== undefined})
						: fail("GitHub answered 200 but named no internal id");
				}),
			),
		),
	);

/** The target's internal `id` alone, for a caller that has no issue-versus-PR question to ask. */
export const internalId = (repo: string, issue: number): Shell<Existence<number>> =>
	edgeTarget(repo, issue).pipe(
		Effect.map(
			(found): Existence<number> => (found._tag === "Present" ? present(found.value.id) : found),
		),
	);

const edgeWrite = (path: string, body: Readonly<Record<string, number>>): Shell<Attempt<void>> =>
	authed((token) =>
		restCall(token, {method: "POST", path, body}).pipe(
			Effect.map((outcome) => {
				if (outcome._tag === "Unreachable") return fail(outcome.reason);
				return outcome.status >= 200 && outcome.status < 300
					? ok(undefined)
					: fail(refusalText(outcome));
			}),
		),
	);

/** Link `childId` under `parent` as a sub-issue. The body carries the integer the API requires. */
export const addSubIssue = (repo: string, parent: number, childId: number): Shell<Attempt<void>> =>
	edgeWrite(`repos/${repo}/issues/${parent}/sub_issues`, {sub_issue_id: childId});

/** Record that `issue` waits on the issue whose internal id is `blockerId`. */
export const addBlockedBy = (
	repo: string,
	issue: number,
	blockerId: number,
): Shell<Attempt<void>> =>
	edgeWrite(`repos/${repo}/issues/${issue}/dependencies/blocked_by`, {issue_id: blockerId});
