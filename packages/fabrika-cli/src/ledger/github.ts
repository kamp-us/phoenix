/**
 * The GitHub surface this group needs that no shipped module already makes.
 *
 * Two of these are genuinely new to fabrika, and they are the reason this file exists: **nothing
 * shipped writes a sub-issue link.** `plan/github.ts`'s `listSubIssues` is the read half — imported
 * and used as-is where numbers are enough — and the write half (`POST .../sub_issues`,
 * `DELETE .../sub_issue`) is derived here. Both take the child's **database `id`, not its number**,
 * which is the one shape v1 got right and is worth not rediscovering.
 *
 * The two readers below carry fields the shipped readers drop, which is the same justification
 * `plan/github.ts` gives for `getChild` over `getIssue`: {@link listSubIssueEntries} carries the `id`
 * the link and unlink take, and {@link readChildBack} carries labels, assignees **and** milestone
 * together, which no shipped shape does — and a read-back that cannot see all three cannot prove the
 * one create call landed every birth attribute.
 *
 * The package's two standing disciplines hold throughout: every list read pages in full, and a shape
 * that is not what was asked for is a failure, never an empty result.
 */

import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {
	absent,
	type Existence,
	httpStatusOf,
	type IssueRow,
	pagedJson,
	parseIssueRows,
	present,
	unknown,
} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";

/** One existing child, with the id the sub-issue relation is keyed on. */
export interface SubIssueEntry {
	readonly number: number;
	readonly id: number;
	readonly title: string;
	readonly labels: ReadonlyArray<string>;
}

const toSubIssueEntry = (value: unknown): SubIssueEntry | null => {
	if (!isRecord(value) || typeof value.number !== "number" || typeof value.id !== "number") {
		return null;
	}
	const names = Array.isArray(value.labels)
		? value.labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: [];
	if (names.includes(null)) return null;
	return {
		number: value.number,
		id: value.id,
		title: typeof value.title === "string" ? value.title : "",
		labels: names as ReadonlyArray<string>,
	};
};

/** The epic's children from the native sub-issue list, paginated in full, with their ids. */
export const listSubIssueEntries = (
	repo: string,
	epic: number,
): Shell<Attempt<ReadonlyArray<SubIssueEntry>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues/${epic}/sub_issues?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const pages = pagedJson(r.stdout);
		if (pages._tag === "Failure") return pages;
		const entries: SubIssueEntry[] = [];
		for (const page of pages.value) {
			const parsed = parseJson(page);
			if (!Array.isArray(parsed)) {
				return fail("`gh api` exited 0 but its output is not a list of sub-issues");
			}
			for (const value of parsed) {
				const entry = toSubIssueEntry(value);
				if (entry === null) return fail("`gh api` exited 0 but one entry is not a sub-issue");
				entries.push(entry);
			}
		}
		return ok(entries);
	});

/**
 * Every open issue in the repository, paged, pull requests filtered out — the dedup ranker's queue
 * half.
 *
 * Unlike `openIssuesWithLabel` this one is deliberately **unscoped by label**: the question a planner
 * asks is "does this work already exist anywhere in the open backlog", and a label-scoped read would
 * answer a narrower one while looking like an answer to the wider.
 */
export const openBacklog = (repo: string): Shell<Attempt<ReadonlyArray<IssueRow>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues?state=open&per_page=100`,
			"--jq",
			'.[] | select(.pull_request | not) | "\\(.number)\t\\(.title)"',
		]);
		if (!r.ok) return fail(r.reason);
		const rows = parseIssueRows(r.stdout);
		return rows === null
			? fail("`gh api` exited 0 but its output is not a list of issue rows")
			: ok(rows);
	});

export interface ChildCreate {
	readonly title: string;
	readonly body: string;
	readonly labels: ReadonlyArray<string>;
	/** The milestone **number** resolved from its title, or `null` for an unhomed child. */
	readonly milestone: number | null;
	readonly assignees: ReadonlyArray<string>;
}

export interface CreatedChild {
	readonly number: number;
	/** The database id — what the sub-issue link and unlink take. */
	readonly id: number;
}

/**
 * Create the child with **every birth attribute in the one call**.
 *
 * v1's create hardcoded exactly three `labels[]` with no pass-through and set no milestone, so a
 * fourth required label could only be applied by a follow-up PATCH — and a follow-up PATCH opens a
 * window in which the child exists with **no** `ready-for:` value, which is the fail-open shape the
 * #4780 ruling forbids.
 */
export const createChildIssue = (repo: string, input: ChildCreate): Shell<Attempt<CreatedChild>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues`,
			"-f",
			`title=${input.title}`,
			"-f",
			`body=${input.body}`,
			...input.labels.flatMap((label) => ["-f", `labels[]=${label}`]),
			...input.assignees.flatMap((login) => ["-f", `assignees[]=${login}`]),
			...(input.milestone === null ? [] : ["-F", `milestone=${input.milestone}`]),
		]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		if (!isRecord(parsed) || typeof parsed.number !== "number" || typeof parsed.id !== "number") {
			return fail("`gh api` exited 0 but its output is not a created issue");
		}
		return ok({number: parsed.number, id: parsed.id});
	});

/** Link a child to its epic. The relation takes the child's `id`, never its number. */
export const linkSubIssue = (repo: string, epic: number, id: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues/${epic}/sub_issues`,
			"-F",
			`sub_issue_id=${id}`,
		]);
		return r.ok ? ok<void>(undefined) : fail(r.reason);
	});

/** Unlink a child from its epic — the same `id`-not-number shape the link uses. */
export const unlinkSubIssue = (repo: string, epic: number, id: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"DELETE",
			`repos/${repo}/issues/${epic}/sub_issue`,
			"-F",
			`sub_issue_id=${id}`,
		]);
		return r.ok ? ok<void>(undefined) : fail(r.reason);
	});

/** Close a child as `not_planned` — the only close spelling a supersede may use. */
export const closeAsNotPlanned = (repo: string, child: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"PATCH",
			`repos/${repo}/issues/${child}`,
			"-f",
			"state=closed",
			"-f",
			"state_reason=not_planned",
		]);
		return r.ok ? ok<void>(undefined) : fail(r.reason);
	});

/** What a create's read-back has to be able to see, so every birth attribute is provable. */
export interface ChildReadback {
	readonly number: number;
	readonly labels: ReadonlyArray<string>;
	readonly assignees: ReadonlyArray<string>;
	readonly milestone: string | null;
	readonly state: string;
	readonly stateReason: string | null;
	readonly body: string;
}

const toChildReadback = (value: unknown): ChildReadback | null => {
	if (!isRecord(value) || typeof value.number !== "number") return null;
	const names = Array.isArray(value.labels)
		? value.labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: [];
	if (names.includes(null)) return null;
	const logins = Array.isArray(value.assignees)
		? value.assignees.map((a) => (isRecord(a) && typeof a.login === "string" ? a.login : null))
		: [];
	if (logins.includes(null)) return null;
	const milestone = value.milestone;
	return {
		number: value.number,
		labels: (names as ReadonlyArray<string>).toSorted(),
		assignees: (logins as ReadonlyArray<string>).toSorted(),
		milestone: isRecord(milestone) && typeof milestone.title === "string" ? milestone.title : null,
		state: typeof value.state === "string" ? value.state : "",
		stateReason: typeof value.state_reason === "string" ? value.state_reason : null,
		body: typeof value.body === "string" ? value.body : "",
	};
};

/** One child re-read from the API. The create response's own echo is never evidence. */
export const readChildBack = (repo: string, child: number): Shell<Existence<ChildReadback>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/issues/${child}`]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404
				? absent<ChildReadback>()
				: unknown<ChildReadback>(r.reason);
		}
		const payload = toChildReadback(parseJson(r.stdout));
		return payload === null
			? unknown<ChildReadback>("`gh api` exited 0 but its output is not an issue")
			: present(payload);
	});
