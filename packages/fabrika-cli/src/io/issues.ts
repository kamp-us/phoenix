/**
 * The GitHub surface the `report` verbs read and write: the intake queue, the search index, the
 * repository's label set, and the issue/comment writes plus their read-backs.
 *
 * Everything goes through `gh api` REST and **never GraphQL** — the org's Projects-classic
 * integration errors out GraphQL issue queries — and **every list read pages**: an unpaginated
 * first page is a silently short answer, which for a duplicate check is a false `none`.
 *
 * Two disciplines this module exists to make unavoidable:
 *
 * - **Absent and unreadable are different outcomes.** `gh` reports a 404 and a 502 the same way —
 *   a non-zero exit — so {@link Existence} splits them on the `(HTTP <n>)` status `gh` prints. A
 *   caller may only seat a proven "does not exist" refusal on `Absent`; `Unknown` refuses on its
 *   own code with nothing on stdout.
 * - **A shape that is not what was asked for is a failure, never an empty result.** Every parser
 *   validates before anything interprets, because `gh` can exit 0 having printed something else.
 */
import {Effect} from "effect";
import {execCapture} from "./exec.ts";
import {type Attempt, fail, ok, originRepo, type Shell} from "./git.ts";
import {isRecord, parseJson} from "./json.ts";

/** A three-way probe: proven present, proven absent, or unreadable — never two of those fused. */
export type Existence<A> =
	| {readonly _tag: "Present"; readonly value: A}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Unknown"; readonly reason: string};

export const present = <A>(value: A): Existence<A> => ({_tag: "Present", value});
export const absent = <A>(): Existence<A> => ({_tag: "Absent"});
export const unknown = <A>(reason: string): Existence<A> => ({_tag: "Unknown", reason});

/** The HTTP status `gh` names in `gh: Not Found (HTTP 404)`, or `null` when it named none. */
export const httpStatusOf = (reason: string): number | null => {
	const m = /\(HTTP (\d{3})\)/.exec(reason);
	return m?.[1] === undefined ? null : Number.parseInt(m[1], 10);
};

/** One issue as the dedup ranking sees it. */
export interface IssueRow {
	readonly number: number;
	readonly title: string;
}

/** `<number>\t<title>` rows, or `null` when a row is not that shape. */
export const parseIssueRows = (stdout: string): ReadonlyArray<IssueRow> | null => {
	const rows: IssueRow[] = [];
	for (const line of stdout.split("\n")) {
		if (line === "") continue;
		const tab = line.indexOf("\t");
		if (tab <= 0) return null;
		const number = line.slice(0, tab);
		if (!/^\d+$/.test(number)) return null;
		rows.push({number: Number.parseInt(number, 10), title: line.slice(tab + 1)});
	}
	return rows;
};

/**
 * The target repository, in the precedence the contract states: `--repo`, then
 * `$CLAUDE_PIPELINE_REPO`, then `$GITHUB_REPOSITORY`, then the `origin` remote. With none
 * resolvable the caller exits 1 rather than guessing which repo to touch.
 */
export const resolveRepo = (
	explicit: string | null,
	env: Readonly<Record<string, string | undefined>>,
): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const named = explicit ?? env.CLAUDE_PIPELINE_REPO ?? env.GITHUB_REPOSITORY ?? "";
		if (named.trim() !== "") return ok(named.trim());
		return yield* originRepo;
	});

/** The current branch ref, or `null` when git cannot say or the head is detached. */
export const currentBranch: Shell<string | null> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	const name = r.stdout.trim();
	return r.ok && name !== "" && name !== "HEAD" ? name : null;
});

/** Every label name defined in `repo`, paged. Doubles as the type/priority vocabulary source. */
export const listLabels = (repo: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/labels?per_page=100`,
			"--jq",
			".[].name",
		]);
		if (!r.ok) return fail(r.reason);
		const names = r.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l !== "");
		return ok(names);
	});

/** Open issues carrying `label`, paged, with pull requests filtered out. */
export const openIssuesWithLabel = (
	repo: string,
	label: string,
): Shell<Attempt<ReadonlyArray<IssueRow>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
			"--jq",
			'.[] | select(.pull_request | not) | "\\(.number)\t\\(.title)"',
		]);
		if (!r.ok) return fail(r.reason);
		const rows = parseIssueRows(r.stdout);
		return rows === null
			? fail("`gh api` exited 0 but its output is not a list of issue rows")
			: ok(rows);
	});

/**
 * The search index's open issues for `tokens`.
 *
 * GitHub AND-joins search terms, which is why the caller caps the token list — an over-long query
 * matches nothing and would read back as a clean `none`.
 */
export const searchOpenIssues = (
	repo: string,
	tokens: ReadonlyArray<string>,
): Shell<Attempt<ReadonlyArray<IssueRow>>> =>
	Effect.gen(function* () {
		const q = `repo:${repo} is:issue is:open ${tokens.join(" ")}`;
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`search/issues?q=${encodeURIComponent(q)}&per_page=100`,
			"--jq",
			'.items[] | "\\(.number)\t\\(.title)"',
		]);
		if (!r.ok) return fail(r.reason);
		const rows = parseIssueRows(r.stdout);
		return rows === null
			? fail("`gh api` exited 0 but its output is not a list of issue rows")
			: ok(rows);
	});

export interface IssueRecord {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly state: string;
	readonly labels: ReadonlyArray<string>;
	readonly url: string;
}

const toIssueRecord = (value: unknown): IssueRecord | null => {
	if (!isRecord(value)) return null;
	const {number, title, body, state, labels, html_url: url} = value;
	if (typeof number !== "number" || typeof title !== "string" || typeof url !== "string") {
		return null;
	}
	const names = Array.isArray(labels)
		? labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: null;
	if (names === null || names.includes(null)) return null;
	return {
		number,
		title,
		body: typeof body === "string" ? body : "",
		state: typeof state === "string" ? state : "",
		labels: names as ReadonlyArray<string>,
		url,
	};
};

/** One issue, probed three ways — the 404 that seats a proven refusal is split from a 5xx. */
export const getIssue = (repo: string, issue: number): Shell<Existence<IssueRecord>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/issues/${issue}`]);
		if (!r.ok) {
			return httpStatusOf(r.reason) === 404
				? absent<IssueRecord>()
				: unknown<IssueRecord>(r.reason);
		}
		const record = toIssueRecord(parseJson(r.stdout));
		return record === null
			? unknown<IssueRecord>("`gh api` exited 0 but its output is not an issue")
			: present(record);
	});

export interface CreatedIssue {
	readonly number: number;
	readonly url: string;
}

/** Create the intake issue carrying exactly one label. */
export const createIssue = (
	repo: string,
	title: string,
	body: string,
	label: string,
): Shell<Attempt<CreatedIssue>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues`,
			"-f",
			`title=${title}`,
			"-f",
			`body=${body}`,
			"-f",
			`labels[]=${label}`,
		]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		if (
			!isRecord(parsed) ||
			typeof parsed.number !== "number" ||
			typeof parsed.html_url !== "string"
		) {
			return fail("`gh api` exited 0 but its output is not a created issue");
		}
		return ok({number: parsed.number, url: parsed.html_url});
	});

export interface CreatedComment {
	readonly id: number;
	readonly url: string;
}

export const createComment = (
	repo: string,
	issue: number,
	body: string,
): Shell<Attempt<CreatedComment>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues/${issue}/comments`,
			"-f",
			`body=${body}`,
		]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		if (!isRecord(parsed) || typeof parsed.id !== "number" || typeof parsed.html_url !== "string") {
			return fail("`gh api` exited 0 but its output is not a created comment");
		}
		return ok({id: parsed.id, url: parsed.html_url});
	});

/** One comment's body, re-read from the API — the create call's own echo is not evidence. */
export const getComment = (repo: string, id: number): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/issues/comments/${id}`]);
		if (!r.ok) return fail(r.reason);
		const parsed = parseJson(r.stdout);
		return isRecord(parsed) && typeof parsed.body === "string"
			? ok(parsed.body)
			: fail("`gh api` exited 0 but its output is not a comment");
	});
