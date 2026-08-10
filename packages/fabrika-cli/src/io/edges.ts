/**
 * GitHub's **native** relationship endpoints: the sub-issue link and the two issue-dependency
 * lists. The frontier's topology is stored here rather than in a map body, so this is the one path
 * to it — a second path is what let v1's prose topology drift from the graph it described.
 *
 * The `issues.ts` disciplines hold unchanged: `gh api` REST and never GraphQL, every list read paged,
 * absent split from unreadable through {@link Existence}, and a shape that is not what was asked for
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
import {execCapture} from "./exec.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {absent, type Existence, httpStatusOf, pagedJson, present, unknown} from "./issues.ts";
import {isRecord, parseJson} from "./json.ts";

/** The issue numbers in a paged list response, or the reason the bytes are not that. */
const issueNumbers = (stdout: string): Attempt<ReadonlyArray<number>> => {
	const pages = pagedJson(stdout);
	if (pages._tag === "Failure") return pages;
	const numbers: number[] = [];
	for (const page of pages.value) {
		const parsed = parseJson(page);
		if (!Array.isArray(parsed)) return fail("`gh api` exited 0 but its output is not a list");
		for (const value of parsed) {
			if (!isRecord(value) || typeof value.number !== "number") {
				return fail("`gh api` exited 0 but one entry carries no issue number");
			}
			numbers.push(value.number);
		}
	}
	return ok(numbers);
};

const listRelation = (repo: string, path: string): Shell<Existence<ReadonlyArray<number>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", "--paginate", `repos/${repo}/${path}?per_page=100`]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404
				? absent<ReadonlyArray<number>>()
				: unknown<ReadonlyArray<number>>(r.reason);
		}
		const numbers = issueNumbers(r.stdout);
		return numbers._tag === "Failure"
			? unknown<ReadonlyArray<number>>(numbers.reason)
			: present(numbers.value);
	});

/** The map's children. `200 []` is a proven-empty child set; a non-404 error is `Unknown`. */
export const subIssues = (repo: string, parent: number): Shell<Existence<ReadonlyArray<number>>> =>
	listRelation(repo, `issues/${parent}/sub_issues`);

/** What a ticket waits on. */
export const blockedBy = (repo: string, issue: number): Shell<Existence<ReadonlyArray<number>>> =>
	listRelation(repo, `issues/${issue}/dependencies/blocked_by`);

/** What a ticket gates. */
export const blocking = (repo: string, issue: number): Shell<Existence<ReadonlyArray<number>>> =>
	listRelation(repo, `issues/${issue}/dependencies/blocking`);

/** The target's internal `id` — the value both POST bodies take, never the issue number. */
export const internalId = (repo: string, issue: number): Shell<Existence<number>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/issues/${issue}`, "--jq", ".id"]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<number>() : unknown<number>(r.reason);
		}
		const id = r.stdout.trim();
		return /^\d+$/.test(id)
			? present(Number.parseInt(id, 10))
			: unknown<number>("`gh api` exited 0 but named no internal id");
	});

/** Link `childId` under `parent` as a sub-issue. `-F` sends the integer the API requires. */
export const addSubIssue = (repo: string, parent: number, childId: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues/${parent}/sub_issues`,
			"-F",
			`sub_issue_id=${childId}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** Record that `issue` waits on the issue whose internal id is `blockerId`. */
export const addBlockedBy = (
	repo: string,
	issue: number,
	blockerId: number,
): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues/${issue}/dependencies/blocked_by`,
			"-F",
			`issue_id=${blockerId}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});
