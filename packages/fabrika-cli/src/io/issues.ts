/**
 * The GitHub surface the `report` and `triage` verbs read and write: the intake queue, the search
 * index, the repository's label set and open milestones, and the issue/comment writes plus their
 * read-backs.
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
 * Open issues in `repo` whose title is **exactly** `title`, paged, pull requests filtered out.
 *
 * Matched over the issues endpoint rather than through the search index on purpose: search is
 * eventually consistent and caps its result set, so a durable artifact created moments ago can read
 * back as absent — and "absent" is the one answer an artifact lookup must never get wrong.
 */
export const openIssuesTitled = (
	repo: string,
	title: string,
): Shell<Attempt<ReadonlyArray<IssueRow>>> =>
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
			: ok(rows.filter((row) => row.title === title));
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
	/**
	 * The filing account's login, or `""` when the payload carried none.
	 *
	 * `""` is the fail-closed value on purpose: the provenance predicate reads this field, and an
	 * empty login can never be a member of the configured operator set, so an unreadable author
	 * falls back to the footer-only test — the protected direction.
	 */
	readonly author: string;
	/**
	 * The assigned milestone's number, or `null` for an unhomed issue.
	 *
	 * A home write cannot be proven from the labels, so a read-back that does not carry this field
	 * cannot tell "homed where I asked" from "not homed at all".
	 */
	readonly milestone: number | null;
	/** `completed` / `not_planned` on a closed issue, `null` otherwise. A kill's read-back reads it. */
	readonly stateReason: string | null;
}

const toIssueRecord = (value: unknown): IssueRecord | null => {
	if (!isRecord(value)) return null;
	const {number, title, body, state, labels, html_url: url, milestone, state_reason, user} = value;
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
		author: isRecord(user) && typeof user.login === "string" ? user.login : "",
		milestone:
			isRecord(milestone) && typeof milestone.number === "number" ? milestone.number : null,
		stateReason: typeof state_reason === "string" ? state_reason : null,
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

/**
 * Create an issue carrying **no** label — the durable-artifact shape.
 *
 * Separate from {@link createIssue} rather than a nullable parameter: an artifact issue is not
 * intake, and a stray label on it would put it in a queue something else drains.
 */
export const createUnlabelledIssue = (
	repo: string,
	title: string,
	body: string,
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

/** Create one repository label with GitHub's default colour and a description naming its creator. */
export const createLabel = (
	repo: string,
	name: string,
	description: string,
): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/labels`,
			"-f",
			`name=${name}`,
			"-f",
			`description=${description}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
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

// ---------------------------------------------------------------------------------------------
// The `triage` group's reads and writes, appended as one block so later verb slices extend the
// file here without colliding with the `report` half above.
// ---------------------------------------------------------------------------------------------

/**
 * Split `stdout` into rows of exactly `columns` tab-separated fields, or `null` when any line is not
 * that shape.
 *
 * The wider sibling of {@link parseIssueRows}: same discipline, any column count. A shape that is
 * not what was asked for is a failure, never an empty result — `gh` can exit 0 having printed a `jq`
 * error, and interpreting those bytes positionally is how a malformed read answers a plausible
 * value.
 */
export const parseTabRows = (
	stdout: string,
	columns: number,
): ReadonlyArray<ReadonlyArray<string>> | null => {
	const rows: ReadonlyArray<string>[] = [];
	for (const line of stdout.split("\n")) {
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length !== columns) return null;
		rows.push(fields);
	}
	return rows;
};

/** The leading field of every tab row as a non-negative integer — `null` if any is not one. */
const leadingNumbers = (
	rows: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<number> | null => {
	const out: number[] = [];
	for (const row of rows) {
		const first = row[0];
		if (first === undefined || !/^\d+$/.test(first)) return null;
		out.push(Number.parseInt(first, 10));
	}
	return out;
};

/** One open milestone, as a home candidate. */
export interface Milestone {
	readonly number: number;
	readonly title: string;
}

/**
 * Every **open** milestone in `repo`, paged.
 *
 * The pagination is load-bearing rather than defensive: an unpaginated read caps candidates at
 * GitHub's default page of 30 with no truncation signal, and "no home fits" is a conclusion that
 * routes work toward a park or a close.
 */
export const listOpenMilestones = (repo: string): Shell<Attempt<ReadonlyArray<Milestone>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/milestones?state=open&per_page=100`,
			"--jq",
			'.[] | "\\(.number)\t\\(.title)"',
		]);
		if (!r.ok) return fail(r.reason);
		const rows = parseTabRows(r.stdout, 2);
		if (rows === null) return fail("`gh api` exited 0 but its output is not a list of milestones");
		const numbers = leadingNumbers(rows);
		if (numbers === null) {
			return fail("`gh api` exited 0 but a milestone row does not start with a number");
		}
		return ok(rows.map((row, i) => ({number: numbers[i] as number, title: row[1] ?? ""})));
	});

/**
 * The pages a paginated read produced, or the proof that its output stopped mid-flight.
 *
 * `Truncated` exists because the alternative is a partial answer that reads as a complete one: a
 * paginated read whose stdout ends inside a page yields *fewer* rows and no error at all, so a caller
 * that only ever sees pages cannot tell "the board holds three issues" from "the read died after
 * three". A caller that receives `Truncated` seats it as UNKNOWN.
 */
export interface JsonPages {
	/** Every page that closed. Complete pages stay readable even when a later one is cut short. */
	readonly pages: ReadonlyArray<string>;
	/** Why the output does not end on a page boundary, or `null` when every byte was accounted for. */
	readonly truncated: string | null;
}

/**
 * Split `gh api --paginate`'s concatenated top-level JSON values back into one string per page, and
 * say so when the output does not end on a page boundary.
 *
 * `--paginate` emits `[…][…]` with no separator, which `JSON.parse` rejects outright — so a
 * single-parse read would fail on exactly the responses pagination exists to reach. Bracket depth is
 * counted outside string literals only, so a `[` inside a comment body cannot split a page.
 *
 * Truncation is **everything the scan could not account for**, not an end-of-input special case: an
 * unclosed value, an unterminated string, a stray `]`, or any non-whitespace byte sitting outside a
 * completed page. Testing the leftovers rather than the final depth is what makes a half-written page
 * in the *middle* of the stream as visible as one at its end.
 */
/** Non-whitespace characters in `[from, to)` — bytes no closed page accounts for. */
const countOutsideWhitespace = (text: string, from: number, to: number): number => {
	let count = 0;
	for (let i = from; i < to; i++) {
		if (!/\s/.test(text[i] ?? "")) count++;
	}
	return count;
};

export const scanJsonPages = (stdout: string): JsonPages => {
	const pages: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	/** The index just past the last closed page — everything before it is accounted for. */
	let closed = 0;
	let stray = 0;
	for (let i = 0; i < stdout.length; i++) {
		const c = stdout[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "[" || c === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (c === "]" || c === "}") {
			depth--;
			if (depth === 0 && start >= 0) {
				stray += countOutsideWhitespace(stdout, closed, start);
				pages.push(stdout.slice(start, i + 1));
				closed = i + 1;
				start = -1;
			} else if (depth < 0) {
				depth = 0;
				stray++;
			}
		}
	}
	stray += countOutsideWhitespace(stdout, closed, stdout.length);
	return {
		pages,
		truncated:
			stray === 0
				? null
				: `the paginated output does not end on a page boundary — ${pages.length} complete page(s), then ${stray} byte(s) of an incomplete one`,
	};
};

/**
 * The pages of a paginated read, or the failure a truncated one is.
 *
 * This is the only sanctioned way to consume {@link scanJsonPages} from a list read: it discharges
 * `truncated` on the caller's behalf, so no reader can receive the pages while dropping the proof
 * that they are not all of them (#5127). Its predecessor returned `.pages` alone and every caller
 * silently answered short.
 */
export const pagedJson = (stdout: string): Attempt<ReadonlyArray<string>> => {
	const scanned = scanJsonPages(stdout);
	return scanned.truncated === null ? ok(scanned.pages) : fail(scanned.truncated);
};

/** One issue comment, as a claim scan reads it. */
export interface CommentRecord {
	readonly id: number;
	readonly author: string;
	readonly createdAt: string;
	/**
	 * When the body was last written.
	 *
	 * Ordering a verdict sweep by `createdAt` is #4200: a FAIL upserted into an older comment after
	 * a PASS must win, and only the write stamp says so.
	 */
	readonly updatedAt: string;
	readonly body: string;
}

/**
 * Every comment on `issue`, paged, oldest first.
 *
 * The bodies arrive as typed JSON rather than through `--jq .body`: a body carrying an unescaped
 * control character makes `jq -r` error mid-stream, which inside a loop reads back as an empty
 * comment rather than as a failure.
 *
 * A truncated read is a failure here for the same reason, one step further out: the claim resolver
 * reads its markers through this call, and a short comment list would let an unreadable marker set
 * refuse as a *proven* loss — retracting a marker that had in fact won (#5127).
 */
export const listComments = (
	repo: string,
	issue: number,
): Shell<Attempt<ReadonlyArray<CommentRecord>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues/${issue}/comments?per_page=100`,
		]);
		if (!r.ok) return fail(r.reason);
		const pages = pagedJson(r.stdout);
		if (pages._tag === "Failure") return pages;
		const out: CommentRecord[] = [];
		for (const page of pages.value) {
			const parsed = parseJson(page);
			if (!Array.isArray(parsed)) {
				return fail("`gh api` exited 0 but its output is not a list of comments");
			}
			for (const value of parsed) {
				if (!isRecord(value) || typeof value.id !== "number") {
					return fail("`gh api` exited 0 but one entry is not a comment");
				}
				const user = value.user;
				out.push({
					id: value.id,
					author: isRecord(user) && typeof user.login === "string" ? user.login : "",
					createdAt: typeof value.created_at === "string" ? value.created_at : "",
					updatedAt: typeof value.updated_at === "string" ? value.updated_at : "",
					body: typeof value.body === "string" ? value.body : "",
				});
			}
		}
		return ok(out);
	});

/** Delete one issue comment — how a claim is retracted. */
export const deleteComment = (repo: string, id: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"DELETE",
			`repos/${repo}/issues/comments/${id}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** Replace an issue's body. The caller re-reads and compares; this call's echo is not evidence. */
export const patchIssueBody = (repo: string, issue: number, body: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"PATCH",
			`repos/${repo}/issues/${issue}`,
			"-f",
			`body=${body}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** Add labels to an issue, leaving every label already on it in place. */
export const addLabels = (
	repo: string,
	issue: number,
	labels: ReadonlyArray<string>,
): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		if (labels.length === 0) return ok(undefined);
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues/${issue}/labels`,
			...labels.flatMap((l) => ["-f", `labels[]=${l}`]),
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/**
 * Remove one label from an issue. `true` = it was removed, `false` = it was already absent.
 *
 * The 404 folds into the success channel deliberately: removal is idempotent, so a label that was
 * not on the issue leaves the caller in exactly the state it asked for. Every other failure stays a
 * failure — "I could not remove it" and "it is gone" are opposite facts.
 */
export const removeLabel = (repo: string, issue: number, label: string): Shell<Attempt<boolean>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"DELETE",
			`repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`,
		]);
		if (r.ok) return ok(true);
		return httpStatusOf(r.reason) === 404 ? ok(false) : fail(r.reason);
	});

/** Home an issue on a milestone by number. */
export const setMilestone = (
	repo: string,
	issue: number,
	milestone: number,
): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"PATCH",
			`repos/${repo}/issues/${issue}`,
			"-F",
			`milestone=${milestone}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/**
 * Clear an issue's milestone.
 *
 * `-F` is what sends a JSON `null`; the `-f` form would send the four-character string `"null"`,
 * which the API rejects rather than reading as a clear.
 */
export const clearMilestone = (repo: string, issue: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"PATCH",
			`repos/${repo}/issues/${issue}`,
			"-F",
			"milestone=null",
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** Close an issue as `not_planned` — the only close spelling a kill may use. */
export const closeNotPlanned = (repo: string, issue: number): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--method",
			"PATCH",
			`repos/${repo}/issues/${issue}`,
			"-f",
			"state=closed",
			"-f",
			"state_reason=not_planned",
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** One intake-queue row. `IssueRow` omits `created_at`, and the age is half of what a queue prints. */
export interface QueueIssue {
	readonly number: number;
	readonly createdAt: string;
	readonly title: string;
}

/**
 * Open issues carrying `label` with their filing time, paged, pull requests filtered out.
 *
 * The rows are cut at the **first two** tabs rather than through {@link parseTabRows}, because a
 * title may itself contain a tab: a strict three-field split would turn one odd title into a failed
 * read of the whole queue, and a queue that cannot be read is a sweep that cannot terminate.
 */
export const openQueueIssues = (
	repo: string,
	label: string,
): Shell<Attempt<ReadonlyArray<QueueIssue>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
			"--jq",
			'.[] | select(.pull_request | not) | "\\(.number)\t\\(.created_at)\t\\(.title)"',
		]);
		if (!r.ok) return fail(r.reason);
		const rows: QueueIssue[] = [];
		for (const line of r.stdout.split("\n")) {
			if (line === "") continue;
			const first = line.indexOf("\t");
			const second = line.indexOf("\t", first + 1);
			if (first <= 0 || second <= first) {
				return fail("`gh api` exited 0 but its output is not a list of queue rows");
			}
			const number = line.slice(0, first);
			const createdAt = line.slice(first + 1, second);
			if (!/^\d+$/.test(number) || Number.isNaN(Date.parse(createdAt))) {
				return fail("`gh api` exited 0 but a queue row carries no issue number and filing time");
			}
			rows.push({number: Number.parseInt(number, 10), createdAt, title: line.slice(second + 1)});
		}
		return ok(rows);
	});

/** An issue or pull request that references this one, from the timeline. */
export interface CrossReference {
	readonly number: number;
	readonly isPullRequest: boolean;
}

/**
 * The `cross-referenced` entries of an issue's timeline, paged — what already points at this issue.
 *
 * A split child is keyed on its parent back-reference, so this read is what makes creating one
 * idempotent: an existing cross-reference is the evidence the child is already there.
 */
export const issueTimeline = (
	repo: string,
	issue: number,
): Shell<Attempt<ReadonlyArray<CrossReference>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", [
			"api",
			"--paginate",
			`repos/${repo}/issues/${issue}/timeline?per_page=100`,
			"--jq",
			'.[] | select(.event == "cross-referenced") | "\\(.source.issue.number)\t\\(.source.issue.pull_request != null)"',
		]);
		if (!r.ok) return fail(r.reason);
		const rows = parseTabRows(r.stdout, 2);
		if (rows === null) return fail("`gh api` exited 0 but its output is not a timeline");
		const numbers = leadingNumbers(rows);
		if (numbers === null) {
			return fail("`gh api` exited 0 but a timeline row does not start with an issue number");
		}
		return ok(
			rows.map((row, i) => ({number: numbers[i] as number, isPullRequest: row[1] === "true"})),
		);
	});
