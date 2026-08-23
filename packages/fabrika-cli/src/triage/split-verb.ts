/**
 * `triage split` — create one child of a bundled report, **once**, and cross-link the parent.
 *
 * One transaction: the label precondition, the two reads that decide `created` vs `reused`, the
 * create, its read-back, and the parent comment. Splitting them would hand a caller the chance to
 * skip one, and the one most worth skipping is the read that prevents a twin.
 *
 * **Where the guarantee lives.** Read 1 — the `status:needs-triage` queue — is the create-once read:
 * it is the read-after-write-consistent source, and every child this verb makes carries that label by
 * construction, so the read can see its own output. Read 2 — the parent's timeline — is
 * supplementary: it reaches children already triaged out of the queue, and it lags by an observed
 * 30–60 minutes (#4057), which is why it widens the net and carries nothing.
 *
 * **A read that cannot see is never an answer.** Every unreadable precondition — the parent, the
 * label set, the queue, the timeline, or any candidate's body — exits `11`. Falling through an
 * `Unknown` to "no match, therefore create" is exactly how one split becomes two issues on a public
 * board, and it is the defect the predecessor shipped: its guard printed a number or nothing, so an
 * auth failure read as a proven "safe to create".
 */

import {Effect} from "effect";
import {
	createComment,
	createIssue,
	currentBranch,
	type Existence,
	getIssue,
	type IssueRecord,
	issueTimeline,
	listLabels,
	openIssuesWithLabel,
	resolveRepo,
} from "../io/issues.ts";
import {sessionIdFrom} from "../io/session-id.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback, renderFooter} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, WRITE_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {scannedLine} from "./scope.ts";
import {
	type Candidate,
	composeChildBody,
	crossLinkComment,
	isExistingChild,
	normalizeTitle,
} from "./split.ts";
import {guardTarget} from "./target-guard.ts";

const VERB = "triage split";
const QUEUE_LABEL = "status:needs-triage";

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the child body",
	emptyHint: "pipe the child body in.",
};

export interface SplitOptions {
	/** The parent issue this unit is split from. */
	readonly parent: number;
	readonly title: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The claim token `triage claim` handed this lane — which lane of the session is asking. */
	readonly token: string | null;
	/** The fd-0 read, injected so the failed-read and TTY paths are testable without a descriptor. */
	readonly stdin: Effect.Effect<StdinRead>;
	/** The footer's timestamp, injected so a child body is byte-reproducible in a test. */
	readonly now: () => Date;
}

const utc = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

/** The one `11` message, so every unreadable precondition refuses in the same words. */
const unreadable = (
	what: string,
	repo: string,
	reason: string,
	diagnostics: ReadonlyArray<string>,
): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`${VERB}: cannot read ${what} in ${repo}: ${reason} — UNKNOWN whether a child already exists; refusing to create a possible twin.`,
		diagnostics,
	);

const asCandidate = (issue: IssueRecord): Candidate => ({
	number: issue.number,
	title: issue.title,
	body: issue.body,
	url: issue.url,
});

/**
 * The reuse answer.
 *
 * `crossLinked` is `false` on every reuse and that is a fact, not a failure: a reuse stops before the
 * cross-link, because the parent was linked when the child was first created. The existing child's
 * body is **not** updated from stdin either — a reuse is an idempotency answer, not an edit, and
 * rewriting a child someone may have already triaged would lose their work.
 */
const reused = (
	child: Candidate,
	json: boolean,
	diagnostics: ReadonlyArray<string>,
): VerbOutcome =>
	json
		? answer(
				JSON.stringify({
					outcome: "reused",
					number: child.number,
					url: child.url,
					matchedOn: "back-reference+title",
					crossLinked: false,
				}),
				diagnostics,
			)
		: answer(`reused\t${child.number}\t${child.url}`, diagnostics);

/** What the read-back found wrong, or `null` when the child landed as composed. */
export const readbackMismatch = (
	landed: Existence<IssueRecord>,
	composed: string,
): string | null => {
	if (landed._tag === "Absent") return "the child is not readable after the create";
	if (landed._tag === "Unknown") return `the read-back itself failed: ${landed.reason}`;
	return normalizeForReadback(landed.value.body) === normalizeForReadback(composed)
		? null
		: "the landed body differs from what was composed";
};

/**
 * The verb, as one `Effect.fn` generator rather than a function returning `Effect.gen` — effect-smol
 * `LLMS.md` §"Using Effect.fn" ("Avoid creating functions that return an Effect.gen").
 */
export const runSplit = Effect.fn(function* (options: SplitOptions) {
	const {parent, title, json} = options;

	if (!Number.isInteger(parent) || parent <= 0) {
		return refuse(FAILED, `${VERB}: ${parent} is not an issue number.`);
	}
	if (title.trim() === "") {
		return refuse(FAILED, `${VERB}: --title is empty — refusing to create an untitled child.`);
	}

	const repoAttempt = yield* resolveRepo(options.repo, options.env);
	if (repoAttempt._tag === "Failure") {
		return refuse(
			FAILED,
			`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
		);
	}
	const repo = repoAttempt.value;

	const authored = readAuthored(SURFACE, yield* options.stdin);
	if (authored._tag === "Refused") return authored.outcome;

	const footer = renderFooter({
		session: sessionIdFrom(options.env),
		model: options.env.ANTHROPIC_MODEL ?? options.env.CLAUDE_MODEL ?? null,
		branch: yield* currentBranch,
		timestamp: utc(options.now()),
	});
	const composed = composeChildBody(authored.text, parent, footer);
	const leaked = leakRefusal(SURFACE, composed);
	if (leaked !== null) return leaked;

	const parentIssue = yield* getIssue(repo, parent);
	if (parentIssue._tag === "Absent") {
		return refuse(ZERO_SCOPE, `${VERB}: parent #${parent} not found in ${repo}.`);
	}
	if (parentIssue._tag === "Unknown") {
		return unreadable(`parent #${parent}`, repo, parentIssue.reason, []);
	}

	const guarded = yield* guardTarget({
		verb: VERB,
		repo,
		issue: parent,
		target: parentIssue.value,
		noun: "parent",
		env: options.env,
		token: options.token,
		now: options.now,
	});
	if (guarded !== null) return guarded;

	// Read 1's label is a hardcoded literal while --repo is generic, so a renamed label or a
	// scope-limited token returns HTTP 200 with `[]` — not a read failure, and therefore not 11. The
	// verb would fall through to `created` and mint a twin, which makes the one verb built to be
	// fail-closed the ADR 0092 fail-open.
	const labels = yield* listLabels(repo);
	if (labels._tag === "Failure") {
		return unreadable("the label set", repo, labels.reason, []);
	}
	if (!labels.value.includes(QUEUE_LABEL)) {
		return refuse(
			ZERO_SCOPE,
			`${VERB}: label ${QUEUE_LABEL} does not exist in ${repo} — refusing to create a child over a queue that would scan nothing (ADR 0092).`,
		);
	}

	const queue = yield* openIssuesWithLabel(repo, QUEUE_LABEL);
	if (queue._tag === "Failure") {
		return unreadable(`the ${QUEUE_LABEL} queue`, repo, queue.reason, []);
	}
	const wanted = normalizeTitle(title);
	// The list read carries titles and no bodies, so the match runs in two stages: narrow on the title
	// the transport did return, then fetch only the survivors. Narrowing first is what keeps the N+1
	// at roughly one.
	const survivors = queue.value.filter((row) => normalizeTitle(row.title) === wanted);
	const diagnostics = [
		scannedLine(
			VERB,
			repo,
			queue.value.length,
			`open ${QUEUE_LABEL} issue`,
			`${survivors.length} title match(es)`,
		),
	];

	const seen = new Set<number>();
	for (const row of survivors) {
		seen.add(row.number);
		const candidate = yield* getIssue(repo, row.number);
		// An Unknown survivor might BE the child, and creating over an unread candidate is exactly the
		// twin this verb exists to prevent.
		if (candidate._tag === "Unknown") {
			return unreadable(`candidate #${row.number}`, repo, candidate.reason, diagnostics);
		}
		if (candidate._tag === "Absent") continue;
		if (isExistingChild(asCandidate(candidate.value), parent, title)) {
			return reused(asCandidate(candidate.value), json, diagnostics);
		}
	}

	const timeline = yield* issueTimeline(repo, parent);
	if (timeline._tag === "Failure") {
		return unreadable(`the timeline of #${parent}`, repo, timeline.reason, diagnostics);
	}
	const references = timeline.value.filter((ref) => !ref.isPullRequest && !seen.has(ref.number));
	diagnostics.push(
		scannedLine(
			VERB,
			repo,
			timeline.value.length,
			"timeline cross-reference",
			`${references.length} issue candidate(s)`,
		),
	);
	for (const ref of references) {
		const candidate = yield* getIssue(repo, ref.number);
		if (candidate._tag === "Unknown") {
			return unreadable(`candidate #${ref.number}`, repo, candidate.reason, diagnostics);
		}
		if (candidate._tag === "Absent") continue;
		if (isExistingChild(asCandidate(candidate.value), parent, title)) {
			return reused(asCandidate(candidate.value), json, diagnostics);
		}
	}

	const created = yield* createIssue(repo, title, composed, QUEUE_LABEL);
	if (created._tag === "Failure") {
		return refuse(
			WRITE_UNKNOWN,
			`${VERB}: create failed: ${created.reason} — UNKNOWN whether a child landed; re-run this verb, which will reuse it if it did.`,
			diagnostics,
		);
	}

	// A create call's own response is the server echoing the request; a fresh read is the only
	// evidence the child carries the back-reference the next run keys on.
	const landed = yield* getIssue(repo, created.value.number);
	const mismatch = readbackMismatch(landed, composed);
	if (mismatch !== null) {
		return refuse(
			READBACK_MISMATCH,
			`${VERB}: child #${created.value.number} created but its body read back changed — inspect before splitting further.`,
			[...diagnostics, `${VERB}: ${mismatch}`],
		);
	}

	// Step 5 is best-effort and never changes the exit status: the child demonstrably exists, so
	// mapping a failed comment onto the create-unknown code would be a lie. The durable trace is the
	// child's own back-reference; this comment is for human readers.
	const linked = yield* createComment(repo, parent, crossLinkComment(created.value.number));
	const notices =
		linked._tag === "Failure"
			? [
					`${VERB}: could not cross-link parent #${parent} to child #${created.value.number}: ${linked.reason} — the child exists; add the comment by hand.`,
				]
			: [];
	const crossLinked = linked._tag === "Ok";

	const out = [...diagnostics, ...notices];
	return json
		? answer(
				JSON.stringify({
					outcome: "created",
					number: created.value.number,
					url: created.value.url,
					matchedOn: null,
					crossLinked,
				}),
				out,
			)
		: answer(`created\t${created.value.number}\t${created.value.url}`, out);
});
