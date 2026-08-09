/**
 * The GitHub reads and writes the `build` verbs need beyond what `io/issues.ts` and `io/pulls.ts`
 * already serve.
 *
 * The house disciplines hold unchanged: `gh api` REST and **never GraphQL**, **every list read pages**
 * (`--paginate`, `per_page=100`), *proven absent* split from *unreadable*, and a shape that is not
 * what was asked for treated as a failure rather than an empty result. The pagination is the one this
 * group most depends on — a truncated bucket is the un-paginated scar these verbs exist to close
 * (#4926), and a candidate pool that silently stops at 100 answers "no p0s".
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {
	absent,
	type Existence,
	httpStatusOf,
	present,
	scanJsonPages,
	unknown,
} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";

/** One issue as the candidate pool ranks it — every axis the filter reads, none of them derived. */
export interface CandidateIssue {
	readonly number: number;
	readonly title: string;
	readonly labels: ReadonlyArray<string>;
	readonly assigned: boolean;
	readonly milestone: number | null;
	readonly isPullRequest: boolean;
}

const toCandidate = (value: unknown): CandidateIssue | null => {
	if (!isRecord(value)) return null;
	const {number, title, labels, assignees, milestone} = value;
	if (typeof number !== "number" || typeof title !== "string") return null;
	const names = Array.isArray(labels)
		? labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: null;
	if (names === null || names.includes(null)) return null;
	return {
		number,
		title,
		labels: names as ReadonlyArray<string>,
		assigned: Array.isArray(assignees) ? assignees.length > 0 : value.assignee !== null,
		milestone:
			isRecord(milestone) && typeof milestone.number === "number" ? milestone.number : null,
		isPullRequest: value.pull_request !== undefined,
	};
};

/**
 * Every open issue carrying **all** of `labels`, paged in full.
 *
 * Typed JSON rather than a `--jq` projection: the filter reads five axes off each row, and a `jq`
 * filter that errors mid-stream on one odd entry shortens the list silently — which is exactly the
 * truncation the caller refuses on.
 *
 * `--paginate` asks for every page; **this read proves it got them.** A stream that stops mid-page —
 * a killed `gh`, a severed transport, a `jq` that died between rows — leaves stdout ending inside a
 * value, and a scan that only collects the pages that *closed* returns a short list on exit 0: a
 * partial board that reads as the whole board. Unaccounted bytes are therefore a failure here, which
 * the pool seats as `11`.
 */
export const listLabelled = (
	repo: string,
	labels: ReadonlyArray<string>,
): Shell<Attempt<ReadonlyArray<CandidateIssue>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues?state=open&labels=${encodeURIComponent(labels.join(","))}&per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const scanned = scanJsonPages(r.stdout);
		if (scanned.truncated !== null) return fail(scanned.truncated);
		const rows: CandidateIssue[] = [];
		for (const page of scanned.pages) {
			const parsed = parseJson(page);
			if (!Array.isArray(parsed)) {
				return fail("`gh api` exited 0 but its output is not a list of issues");
			}
			for (const value of parsed) {
				const row = toCandidate(value);
				if (row === null) return fail("`gh api` exited 0 but one entry is not an issue");
				rows.push(row);
			}
		}
		return ok(rows);
	});

/**
 * An issue's parent epic, through the dedicated sub-endpoint.
 *
 * The single-issue payload carries **no** `parent` key, so a `--jq '.parent'` read there answers its
 * default for every issue — a well-formed, plausible, always-wrong "standalone" (#4171). The
 * sub-endpoint's 404 is the proven-standalone answer; everything else stays UNKNOWN.
 */
export const getParent = (repo: string, issue: number): Shell<Existence<number>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/issues/${issue}/parent`,
			"--jq",
			".number",
		]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<number>() : unknown<number>(r.reason);
		}
		const text = r.stdout.trim();
		return /^\d+$/.test(text)
			? present(Number.parseInt(text, 10))
			: unknown<number>("`gh api` exited 0 but named no parent number");
	});

/** Whether a number is a pull request, read off the issues endpoint's `pull_request` key. */
export const isPullRequest = (repo: string, number: number): Shell<Existence<boolean>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/issues/${number}`,
			"--jq",
			".pull_request != null",
		]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<boolean>() : unknown<boolean>(r.reason);
		}
		const text = r.stdout.trim();
		return text === "true" || text === "false"
			? present(text === "true")
			: unknown<boolean>("`gh api` exited 0 but did not say whether the number is a pull request");
	});

export const defaultBranch = (repo: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"]);
		if (!r.ok) return fail(r.reason);
		const name = r.stdout.trim();
		return name === "" ? fail("`gh api` exited 0 but named no default branch") : ok(name);
	});

export interface PullHead {
	readonly ref: string;
	readonly sha: string;
	readonly state: string;
	readonly merged: boolean;
}

/** A PR's head branch — what resume mode publishes back to through a tracked upstream. */
export const getPullHead = (repo: string, pr: number): Shell<Existence<PullHead>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			`repos/${repo}/pulls/${pr}`,
			"--jq",
			'"\\(.head.ref)\t\\(.head.sha)\t\\(.state)\t\\(.merged)"',
		]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404 ? absent<PullHead>() : unknown<PullHead>(r.reason);
		}
		const [ref, sha, state, merged] = r.stdout.trim().split("\t");
		return ref === undefined || ref === "" || sha === undefined || state === undefined
			? unknown<PullHead>("`gh api` exited 0 but its output is not a pull-request head")
			: present({ref, sha, state, merged: merged === "true"});
	});

export interface PullRef {
	readonly number: number;
	readonly url: string;
}

/**
 * The open PR whose head is `branch`, or `null` when there is none.
 *
 * This is what makes `build pr` idempotent after a `8`: a create whose outcome could not be proven is
 * re-run, and an already-open PR for this head is an **answer**, not a duplicate.
 */
export const openPullForHead = (repo: string, branch: string): Shell<Attempt<PullRef | null>> =>
	Effect.gen(function* () {
		const owner = repo.split("/")[0] ?? "";
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
			"--jq",
			'.[] | "\\(.number)\t\\(.html_url)"',
		]);
		if (!r.ok) return fail(r.reason);
		const first = r.stdout.split("\n").find((line) => line.trim() !== "");
		if (first === undefined) return ok(null);
		const [number, url] = first.split("\t");
		return number === undefined || !/^\d+$/.test(number) || url === undefined
			? fail("`gh api` exited 0 but its output is not a list of pull requests")
			: ok({number: Number.parseInt(number, 10), url});
	});

/**
 * Open a pull request.
 *
 * The body travels as an **argv value**, never `-f body=@file`: the `@` form posts the four-character
 * path as the body and reads back as success (#4683). Passing the bytes directly removes the file
 * indirection the scar lives in rather than guarding it.
 */
export const createPull = (
	repo: string,
	title: string,
	head: string,
	base: string,
	body: string,
): Shell<Attempt<PullRef>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/pulls`,
			"-f",
			`title=${title}`,
			"-f",
			`head=${head}`,
			"-f",
			`base=${base}`,
			"-f",
			`body=${body}`,
		]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		return isRecord(parsed) &&
			typeof parsed.number === "number" &&
			typeof parsed.html_url === "string"
			? ok({number: parsed.number, url: parsed.html_url})
			: fail("`gh api` exited 0 but its output is not a created pull request");
	});

/** One native review on a pull request — its own row kind, never coerced into a marker (#4555). */
export interface ReviewRecord {
	readonly id: number;
	readonly state: string;
	readonly body: string;
}

export const listReviews = (
	repo: string,
	pr: number,
): Shell<Attempt<ReadonlyArray<ReviewRecord>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/pulls/${pr}/reviews?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const scanned = scanJsonPages(r.stdout);
		if (scanned.truncated !== null) return fail(scanned.truncated);
		const rows: ReviewRecord[] = [];
		for (const page of scanned.pages) {
			const parsed = parseJson(page);
			if (!Array.isArray(parsed)) {
				return fail("`gh api` exited 0 but its output is not a list of reviews");
			}
			for (const value of parsed) {
				if (!isRecord(value) || typeof value.id !== "number" || typeof value.state !== "string") {
					return fail("`gh api` exited 0 but one entry is not a review");
				}
				rows.push({
					id: value.id,
					state: value.state,
					body: typeof value.body === "string" ? value.body : "",
				});
			}
		}
		return ok(rows);
	});
