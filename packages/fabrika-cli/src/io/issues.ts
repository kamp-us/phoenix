/**
 * The GitHub surface the `report` and `triage` verbs read and write: the intake queue, the search
 * index, the repository's label set and open milestones, and the issue/comment writes plus their
 * read-backs.
 *
 * Everything goes through `./gh-api.ts` REST and **never GraphQL** — the org's Projects-classic
 * integration errors out the GraphQL issue *search* connection, which is what this module's reads
 * are — and **every list read pages** and refuses a walk it could not prove whole: an unpaginated or
 * capped read is a silently short answer, which for a duplicate check is a false `none`.
 *
 * Two disciplines this module exists to make unavoidable:
 *
 * - **Absent and unreadable are different outcomes.** {@link Existence} splits them on the numeric
 *   status the response carried. A caller may only seat a proven "does not exist" refusal on
 *   `Absent`; `Unknown` refuses on its own code with nothing on stdout.
 * - **A shape that is not what was asked for is a failure, never an empty result.** Every read
 *   validates before anything interprets, because a 200 can carry something else entirely.
 */
import {Effect} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {execCapture} from "./exec.ts";
import {
	type Api,
	existenceOf,
	PAGE_CAP,
	pagedEnvelope,
	pagedWithLinkProof,
	type Rest,
	refusalText,
	resolveToken,
	restRead,
	restWrite,
} from "./gh-api.ts";
import {type Attempt, fail, ok, originRepo, type Shell} from "./git.ts";
import {isRecord} from "./json.ts";

/** A three-way probe: proven present, proven absent, or unreadable — never two of those fused. */
export type Existence<A> =
	| {readonly _tag: "Present"; readonly value: A}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Unknown"; readonly reason: string};

export const present = <A>(value: A): Existence<A> => ({_tag: "Present", value});
export const absent = <A>(): Existence<A> => ({_tag: "Absent"});
export const unknown = <A>(reason: string): Existence<A> => ({_tag: "Unknown", reason});

/** One issue as the dedup ranking sees it. */
export interface IssueRow {
	readonly number: number;
	readonly title: string;
}

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

/**
 * The credential, resolved per call from the ambient environment.
 *
 * `resolveToken` takes an env map so a caller can thread one, and every export below is reached from
 * a hundred-odd call sites that pass none — the port may not change their signatures, so the read
 * happens here. `Effect.suspend` keeps it per call rather than frozen at module load, which is what
 * lets a test set the variable before it runs.
 */
const ambientToken: Shell<Attempt<string>> = Effect.suspend(() => resolveToken(process.env));

/**
 * Run one HTTP leg on whatever transport the caller provided, falling back to `fetch`.
 *
 * The requirement is **erased here rather than published**, and that is a constraint from outside
 * this module: every export below is reached from a hundred-odd sites that annotate `Shell<…>`, so
 * an adapter that demanded an `HttpClient` would red every one of them. A provided client still
 * wins, which is what keeps a unit test's scripted seam the seam production runs on.
 */
const onTransport = <A>(leg: Api<A>): Shell<A> =>
	Effect.gen(function* () {
		const provided = yield* Effect.serviceOption(HttpClient.HttpClient);
		return yield* provided._tag === "Some"
			? Effect.provideService(leg, HttpClient.HttpClient, provided.value)
			: Effect.provide(leg, FetchHttpClient.layer);
	});

/** Sequence two attempts: a failure short-circuits carrying its own reason. */
const then = <A, B>(attempt: Attempt<A>, next: (value: A) => Attempt<B>): Attempt<B> =>
	attempt._tag === "Failure" ? attempt : next(attempt.value);

/** Run `read` under a resolved credential; an unresolvable one is the read's own failure. */
const withToken = <A>(read: (token: string) => Api<Attempt<A>>): Shell<Attempt<A>> =>
	Effect.gen(function* () {
		const token = yield* ambientToken;
		return token._tag === "Failure" ? token : yield* onTransport(read(token.value));
	});

/** A served 2xx body, or the refusal a non-2xx or an unreached endpoint is. */
const servedBody = (outcome: Rest): Attempt<unknown> => {
	if (outcome._tag === "Unreachable") return fail(outcome.reason);
	if (outcome.status < 200 || outcome.status >= 300) return fail(refusalText(outcome));
	return ok(outcome.body);
};

/** A write whose only evidence is its status — the body it echoes is not proof of anything. */
const accepted = (outcome: Rest): Attempt<void> => then(servedBody(outcome), () => ok(undefined));

// A function, not a top-level constant: `gh-api.ts` imports this module back, so at the moment
// this one is evaluated `PAGE_CAP` is still in its exporter's temporal dead zone.
const capped = (): string =>
	`the read reached the ${PAGE_CAP}-page cap with another page still to come — this is not the whole list`;

/**
 * Every paged bare-array read in this module, and a capped walk is a failure rather than a list.
 *
 * There is no proof-dropping sibling on purpose. `gh api --paginate` had no page cap, so a short
 * list was not a state it could produce; this transport caps at {@link PAGE_CAP}, so it is. Handing
 * the entries on without the flag turns a truncated read into a clean `Ok`, and eight callers seat
 * proven negatives on it — the duplicate check in `openIssuesTitled`, the twin scan in
 * `issueTimeline`, the dedup sweep in `openIssuesWithLabel` — where a short list is a wrong answer
 * rather than a short one.
 */
const provenList = (token: string, path: string): Api<Attempt<ReadonlyArray<unknown>>> =>
	Effect.map(pagedWithLinkProof(token, path), (read) =>
		then(read, (proof) => (proof.exhausted ? ok(proof.entries) : fail(capped()))),
	);

const NOT_ISSUES = "GitHub answered 200 but its body is not a list of issues";

const withoutPullRequests = (entries: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
	entries.filter((entry) => !(isRecord(entry) && isRecord(entry.pull_request)));

const issueRows = (entries: ReadonlyArray<unknown>): Attempt<ReadonlyArray<IssueRow>> => {
	const rows: IssueRow[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.number !== "number" || typeof entry.title !== "string") {
			return fail(NOT_ISSUES);
		}
		rows.push({number: entry.number, title: entry.title});
	}
	return ok(rows);
};

/** Every label name defined in `repo`, paged. Doubles as the type/priority vocabulary source. */
export const listLabels = (repo: string): Shell<Attempt<ReadonlyArray<string>>> =>
	withToken((token) =>
		Effect.map(provenList(token, `repos/${repo}/labels`), (read) =>
			then(read, (entries) => {
				const names: string[] = [];
				for (const entry of entries) {
					if (!isRecord(entry) || typeof entry.name !== "string") {
						return fail("GitHub answered 200 but its body is not a list of labels");
					}
					names.push(entry.name);
				}
				return ok(names);
			}),
		),
	);

const openWithLabel = (repo: string, label: string): string =>
	`repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`;

/** Open issues carrying `label`, paged, with pull requests filtered out. */
export const openIssuesWithLabel = (
	repo: string,
	label: string,
): Shell<Attempt<ReadonlyArray<IssueRow>>> =>
	withToken((token) =>
		Effect.map(provenList(token, openWithLabel(repo, label)), (read) =>
			then(read, (entries) => issueRows(withoutPullRequests(entries))),
		),
	);

/** One issue with the bytes a body-keyed match needs. `body` is `""` when the API sent none. */
export interface IssueDetail extends IssueRow {
	readonly body: string;
}

/**
 * Open issues carrying `label`, paged, with their bodies — the same single list call
 * {@link openIssuesWithLabel} makes, asking the same endpoint for one more field it already returns.
 *
 * It exists because a match keyed on a body line cannot be made from `<number>\t<title>` rows, and
 * re-reading each issue to get one would turn a proven answer into N reads, any of which failing
 * would leave "does a session for this ticket exist" UNKNOWN.
 */
export const openIssuesWithLabelDetailed = (
	repo: string,
	label: string,
): Shell<Attempt<ReadonlyArray<IssueDetail>>> =>
	withToken((token) =>
		Effect.map(provenList(token, openWithLabel(repo, label)), (read) =>
			then(read, (entries) => {
				const rows: IssueDetail[] = [];
				for (const entry of withoutPullRequests(entries)) {
					if (
						!isRecord(entry) ||
						typeof entry.number !== "number" ||
						typeof entry.title !== "string"
					) {
						return fail(NOT_ISSUES);
					}
					rows.push({
						number: entry.number,
						title: entry.title,
						body: typeof entry.body === "string" ? entry.body : "",
					});
				}
				return ok(rows);
			}),
		),
	);

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
	withToken((token) =>
		Effect.map(provenList(token, `repos/${repo}/issues?state=open`), (read) =>
			then(read, (entries) =>
				then(issueRows(withoutPullRequests(entries)), (rows) =>
					ok(rows.filter((row) => row.title === title)),
				),
			),
		),
	);

/**
 * The search index's rows for `query`, paged, and a walk that stopped at the cap is a failure.
 *
 * `search/issues` answers with a `{total_count, items}` envelope. Both callers are duplicate checks,
 * and a duplicate check is the read where a short list is not a short answer but a wrong one: it
 * reports "nothing matches" over a scope nobody proved was searched, and something gets filed twice.
 */
const searchRows = (token: string, query: string): Api<Attempt<ReadonlyArray<IssueRow>>> =>
	Effect.map(
		pagedEnvelope(token, `search/issues?q=${encodeURIComponent(query)}`, "items"),
		(read) =>
			then(read, (envelope) => (envelope.exhausted ? issueRows(envelope.entries) : fail(capped()))),
	);

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
	withToken((token) => searchRows(token, `repo:${repo} is:issue is:open ${tokens.join(" ")}`));

/**
 * The search index's issues for `tokens`, **open and closed**, paged.
 *
 * The sibling of {@link searchOpenIssues}, kept separate rather than parameterised because the two
 * answer different questions and the wrong one is silently plausible: an open-only scan reports a
 * question that was charted and closed as new, which is #4154/#4148's scar. A caller asking "has
 * anyone answered this already?" needs the closed half; one asking "is there an open duplicate?" does
 * not.
 */
export const searchIssues = (
	repo: string,
	tokens: ReadonlyArray<string>,
): Shell<Attempt<ReadonlyArray<IssueRow>>> =>
	withToken((token) => searchRows(token, `repo:${repo} is:issue ${tokens.join(" ")}`));

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
	/**
	 * Issue comments, as the platform counts them — the denominator a completeness proof divides by.
	 *
	 * `0` when the payload carried none, which is the same fail-closed direction the rest of this
	 * record takes: a caller comparing an enumeration against it then proves nothing rather than
	 * proving a short read from a count that was never there.
	 */
	readonly comments: number;
	/**
	 * Whether this number is a pull request rather than an issue.
	 *
	 * `repos/<repo>/issues/<n>` answers for both, and the only thing that tells them apart is the
	 * `pull_request` key. A caller that cannot see the difference reads a PR's empty milestone as an
	 * unhomed issue's (#5562).
	 */
	readonly isPullRequest: boolean;
	/**
	 * Whether this issue hangs under a parent — a sub-issue, which inherits its epic's contract.
	 *
	 * Read from `parent_issue_url` AND `parent`: the sub-issues API has shipped both shapes, and a
	 * reader that knows only `parent` resolves every sub-issue as parentless. **The list endpoints
	 * carry neither key**, so a caller that needs this fact re-reads the issue singly; a list record
	 * always answers `false` here, which is the fail-open direction for a scope filter and the reason
	 * `pitch-verb.ts` never filters on a list record.
	 */
	readonly isSubIssue: boolean;
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
		comments: typeof value.comments === "number" ? value.comments : 0,
		isPullRequest: isRecord(value.pull_request),
		isSubIssue:
			(value.parent_issue_url !== undefined && value.parent_issue_url !== null) ||
			(value.parent !== undefined && value.parent !== null),
	};
};

/** One issue, probed three ways — the 404 that seats a proven refusal is split from a 5xx. */
export const getIssue = (repo: string, issue: number): Shell<Existence<IssueRecord>> =>
	Effect.gen(function* () {
		const token = yield* ambientToken;
		if (token._tag === "Failure") return unknown<IssueRecord>(token.reason);
		const outcome = yield* onTransport(
			restRead(token.value, "GET", `repos/${repo}/issues/${issue}`),
		);
		return existenceOf(outcome, (body) => {
			const record = toIssueRecord(body);
			return record === null
				? fail("GitHub answered 200 but its body is not an issue")
				: ok(record);
		});
	});

export interface CreatedIssue {
	readonly number: number;
	readonly url: string;
}

const createdIssue = (body: unknown): Attempt<CreatedIssue> =>
	isRecord(body) && typeof body.number === "number" && typeof body.html_url === "string"
		? ok({number: body.number, url: body.html_url})
		: fail("GitHub answered 2xx but its body is not a created issue");

/** Create the intake issue carrying exactly one label. */
export const createIssue = (
	repo: string,
	title: string,
	body: string,
	label: string,
): Shell<Attempt<CreatedIssue>> =>
	withToken((token) =>
		Effect.map(
			restWrite(token, "POST", `repos/${repo}/issues`, {title, body, labels: [label]}),
			(outcome) => then(servedBody(outcome), createdIssue),
		),
	);

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
	withToken((token) =>
		Effect.map(restWrite(token, "POST", `repos/${repo}/issues`, {title, body}), (outcome) =>
			then(servedBody(outcome), createdIssue),
		),
	);

/** Create one repository label; `color` is `null` for GitHub's default. */
export const createLabel = (
	repo: string,
	name: string,
	description: string,
	color: string | null,
): Shell<Attempt<void>> =>
	withToken((token) =>
		Effect.map(
			restWrite(token, "POST", `repos/${repo}/labels`, {
				name,
				description,
				...(color === null ? {} : {color}),
			}),
			accepted,
		),
	);

export interface CreatedComment {
	readonly id: number;
	readonly url: string;
}

export const createComment = (
	repo: string,
	issue: number,
	body: string,
): Shell<Attempt<CreatedComment>> =>
	withToken((token) =>
		Effect.map(
			restWrite(token, "POST", `repos/${repo}/issues/${issue}/comments`, {body}),
			(outcome) =>
				then(servedBody(outcome), (served) =>
					isRecord(served) && typeof served.id === "number" && typeof served.html_url === "string"
						? ok({id: served.id, url: served.html_url})
						: fail("GitHub answered 2xx but its body is not a created comment"),
				),
		),
	);

/** One comment's body, re-read from the API — the create call's own echo is not evidence. */
export const getComment = (repo: string, id: number): Shell<Attempt<string>> =>
	withToken((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}/issues/comments/${id}`), (outcome) =>
			then(servedBody(outcome), (body) =>
				isRecord(body) && typeof body.body === "string"
					? ok(body.body)
					: fail("GitHub answered 200 but its body is not a comment"),
			),
		),
	);

/**
 * One comment as a whole record — its author beside its body.
 *
 * Separate from {@link getComment}, which serves the read-back after a write and needs only the
 * bytes. A citation is read for **who** wrote it as much as for what it says, and folding the author
 * into the body-only read would leave every caller of that one carrying a field it never asked for.
 */
export const getCommentRecord = (repo: string, id: number): Shell<Attempt<CommentRecord>> =>
	withToken((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}/issues/comments/${id}`), (outcome) =>
			then(servedBody(outcome), (body) => {
				if (!isRecord(body) || typeof body.body !== "string" || typeof body.id !== "number") {
					return fail("GitHub answered 200 but its body is not a comment");
				}
				// An unreadable author is a failed read, never a blank one: a blank login would
				// downstream as AUTHOR_UNDECLARED (16) — a proven negative about a person GitHub
				// never named. Callers seat this arm on their read-failure exit instead (#6983).
				const user = body.user;
				if (!isRecord(user) || typeof user.login !== "string") {
					return fail("GitHub answered 200 but the comment carries no readable author login");
				}
				return ok({
					id: body.id,
					author: user.login,
					createdAt: typeof body.created_at === "string" ? body.created_at : "",
					updatedAt: typeof body.updated_at === "string" ? body.updated_at : "",
					body: body.body,
				});
			}),
		),
	);

// ---------------------------------------------------------------------------------------------
// The `triage` group's reads and writes, appended as one block so later verb slices extend the
// file here without colliding with the `report` half above.
// ---------------------------------------------------------------------------------------------

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
	withToken((token) =>
		Effect.map(provenList(token, `repos/${repo}/milestones?state=open`), (read) =>
			then(read, (entries) => {
				const milestones: Milestone[] = [];
				for (const entry of entries) {
					if (
						!isRecord(entry) ||
						typeof entry.number !== "number" ||
						typeof entry.title !== "string"
					) {
						return fail("GitHub answered 200 but its body is not a list of milestones");
					}
					milestones.push({number: entry.number, title: entry.title});
				}
				return ok(milestones);
			}),
		),
	);

/** One milestone in whichever state it is actually in — the projection a roadmap row is checked against. */
export interface MilestoneState extends Milestone {
	readonly state: "open" | "closed";
}

/**
 * Every milestone in `repo` **in any state**, paged.
 *
 * `state=all` rather than {@link listOpenMilestones}'s open-only read: `roadmap-guard` has to resolve a
 * `done` row's pin to a CLOSED milestone, and an open-only projection would report that pin as
 * dangling — turning a correctly retired arc into a violation.
 *
 * A row whose state is neither `open` nor `closed` FAILS the read. GitHub has exactly those two, so a
 * third value means the bytes are not the projection that was asked for, and interpreting them
 * positionally is how a malformed read answers a plausible verdict.
 */
export const listMilestones = (repo: string): Shell<Attempt<ReadonlyArray<MilestoneState>>> =>
	withToken((token) =>
		Effect.map(provenList(token, `repos/${repo}/milestones?state=all`), (read) =>
			then(read, (entries) => {
				const milestones: MilestoneState[] = [];
				for (const entry of entries) {
					if (
						!isRecord(entry) ||
						typeof entry.number !== "number" ||
						typeof entry.title !== "string"
					) {
						return fail("GitHub answered 200 but its body is not a list of milestones");
					}
					const state = entry.state;
					if (state !== "open" && state !== "closed") {
						return fail(`GitHub answered 200 but a milestone's state is "${String(state)}"`);
					}
					milestones.push({number: entry.number, state, title: entry.title});
				}
				return ok(milestones);
			}),
		),
	);

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
 * A read that could not be proven whole is a failure: the claim resolver reads its markers through
 * this call, and a short comment list would let an unreadable marker set refuse as a *proven* loss —
 * retracting a marker that had in fact won (#5127).
 */
export const listComments = (
	repo: string,
	issue: number,
): Shell<Attempt<ReadonlyArray<CommentRecord>>> =>
	withToken((token) =>
		Effect.map(provenList(token, `repos/${repo}/issues/${issue}/comments`), (read) =>
			then(read, (entries) => {
				const out: CommentRecord[] = [];
				for (const value of entries) {
					if (!isRecord(value) || typeof value.id !== "number") {
						return fail("GitHub answered 200 but one entry is not a comment");
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
				return ok(out);
			}),
		),
	);

/** Delete one issue comment — how a claim is retracted. */
export const deleteComment = (repo: string, id: number): Shell<Attempt<void>> =>
	withToken((token) =>
		Effect.map(restWrite(token, "DELETE", `repos/${repo}/issues/comments/${id}`), accepted),
	);

/** Replace an issue's body. The caller re-reads and compares; this call's echo is not evidence. */
export const patchIssueBody = (repo: string, issue: number, body: string): Shell<Attempt<void>> =>
	withToken((token) =>
		Effect.map(restWrite(token, "PATCH", `repos/${repo}/issues/${issue}`, {body}), accepted),
	);

/** Add labels to an issue, leaving every label already on it in place. */
export const addLabels = (
	repo: string,
	issue: number,
	labels: ReadonlyArray<string>,
): Shell<Attempt<void>> =>
	labels.length === 0
		? Effect.succeed(ok(undefined))
		: withToken((token) =>
				Effect.map(
					restWrite(token, "POST", `repos/${repo}/issues/${issue}/labels`, {labels: [...labels]}),
					accepted,
				),
			);

/**
 * Remove one label from an issue. `true` = it was removed, `false` = it was already absent.
 *
 * The 404 folds into the success channel deliberately: removal is idempotent, so a label that was
 * not on the issue leaves the caller in exactly the state it asked for. Every other failure stays a
 * failure — "I could not remove it" and "it is gone" are opposite facts.
 */
export const removeLabel = (repo: string, issue: number, label: string): Shell<Attempt<boolean>> =>
	withToken((token) =>
		Effect.map(
			restWrite(
				token,
				"DELETE",
				`repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`,
			),
			(outcome) =>
				outcome._tag === "Response" && outcome.status === 404
					? ok(false)
					: then(accepted(outcome), () => ok(true)),
		),
	);

/** Home an issue on a milestone by number. */
export const setMilestone = (
	repo: string,
	issue: number,
	milestone: number,
): Shell<Attempt<void>> =>
	withToken((token) =>
		Effect.map(restWrite(token, "PATCH", `repos/${repo}/issues/${issue}`, {milestone}), accepted),
	);

/**
 * Clear an issue's milestone.
 *
 * A JSON `null`, which is what the API reads as a clear; the four-character string `"null"` it
 * rejects outright.
 */
export const clearMilestone = (repo: string, issue: number): Shell<Attempt<void>> =>
	withToken((token) =>
		Effect.map(
			restWrite(token, "PATCH", `repos/${repo}/issues/${issue}`, {milestone: null}),
			accepted,
		),
	);

/** Close an issue as `not_planned` — the only close spelling a kill may use. */
export const closeNotPlanned = (repo: string, issue: number): Shell<Attempt<void>> =>
	withToken((token) =>
		Effect.map(
			restWrite(token, "PATCH", `repos/${repo}/issues/${issue}`, {
				state: "closed",
				state_reason: "not_planned",
			}),
			accepted,
		),
	);

/**
 * Close an issue as `completed` — the close spelling for work that reached an answer.
 *
 * Separate from {@link closeNotPlanned} rather than a parameter: the two are opposite claims about
 * the same issue, and a caller that could pass the wrong one silently records "we decided not to"
 * over "we answered it".
 */
export const closeCompleted = (repo: string, issue: number): Shell<Attempt<void>> =>
	withToken((token) =>
		Effect.map(
			restWrite(token, "PATCH", `repos/${repo}/issues/${issue}`, {
				state: "closed",
				state_reason: "completed",
			}),
			accepted,
		),
	);

/** One intake-queue row. `IssueRow` omits `created_at`, and the age is half of what a queue prints. */
export interface QueueIssue {
	readonly number: number;
	readonly createdAt: string;
	readonly title: string;
}

/** Open issues carrying `label` with their filing time, paged, pull requests filtered out. */
export const openQueueIssues = (
	repo: string,
	label: string,
): Shell<Attempt<ReadonlyArray<QueueIssue>>> =>
	withToken((token) =>
		Effect.map(provenList(token, openWithLabel(repo, label)), (read) =>
			then(read, (entries) => {
				const rows: QueueIssue[] = [];
				for (const entry of withoutPullRequests(entries)) {
					if (
						!isRecord(entry) ||
						typeof entry.number !== "number" ||
						typeof entry.title !== "string"
					) {
						return fail(NOT_ISSUES);
					}
					const createdAt = entry.created_at;
					if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
						return fail("GitHub answered 200 but a queue row carries no filing time");
					}
					rows.push({number: entry.number, createdAt, title: entry.title});
				}
				return ok(rows);
			}),
		),
	);

/**
 * Every **open** issue in `repo` as a full record, paged, pull requests filtered out.
 *
 * A read that could not be proven whole is a failure — a sweep over a silently short list reports
 * issues it never looked at as never drifted.
 */
export const listOpenIssues = (repo: string): Shell<Attempt<ReadonlyArray<IssueRecord>>> =>
	openIssueRecords(`repos/${repo}/issues?state=open`);

/**
 * Every **open** issue in `repo` carrying `label`, as full records, paged, pull requests filtered
 * out — {@link listOpenIssues} narrowed at the endpoint rather than in the caller.
 *
 * Its own read because a guard scoped to one label would otherwise page the entire open board to
 * throw most of it away, and every extra page is another chance for the read to fail and leave the
 * verdict UNKNOWN.
 */
export const openIssuesWithLabelRecords = (
	repo: string,
	label: string,
): Shell<Attempt<ReadonlyArray<IssueRecord>>> => openIssueRecords(openWithLabel(repo, label));

const openIssueRecords = (endpoint: string): Shell<Attempt<ReadonlyArray<IssueRecord>>> =>
	withToken((token) =>
		Effect.map(provenList(token, endpoint), (read) =>
			then(read, (entries) => {
				const out: IssueRecord[] = [];
				for (const value of entries) {
					const record = toIssueRecord(value);
					if (record === null) return fail("GitHub answered 200 but one entry is not an issue");
					if (!record.isPullRequest) out.push(record);
				}
				return ok(out);
			}),
		),
	);

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
	withToken((token) =>
		Effect.map(provenList(token, `repos/${repo}/issues/${issue}/timeline`), (read) =>
			then(read, (entries) => {
				const out: CrossReference[] = [];
				for (const entry of entries) {
					if (!isRecord(entry)) return fail("GitHub answered 200 but its body is not a timeline");
					if (entry.event !== "cross-referenced") continue;
					const source = entry.source;
					const referenced = isRecord(source) ? source.issue : undefined;
					if (!isRecord(referenced) || typeof referenced.number !== "number") {
						return fail("GitHub answered 200 but a cross-reference names no issue number");
					}
					out.push({
						number: referenced.number,
						isPullRequest:
							referenced.pull_request !== undefined && referenced.pull_request !== null,
					});
				}
				return ok(out);
			}),
		),
	);

/**
 * The repository's default branch.
 *
 * Its own read because the single-issue payload carries none: `repos/{repo}/issues/{n}` returns no
 * `repository` object, so a caller defaulting a base branch "off the issue payload" would be reading
 * a field that is not there.
 */
export const repoDefaultBranch = (repo: string): Shell<Attempt<string>> =>
	withToken((token) =>
		Effect.map(restRead(token, "GET", `repos/${repo}`), (outcome) =>
			then(servedBody(outcome), (body) => {
				const name =
					isRecord(body) && typeof body.default_branch === "string" ? body.default_branch : "";
				return name.trim() === ""
					? fail("GitHub answered 200 but named no default branch")
					: ok(name.trim());
			}),
		),
	);
