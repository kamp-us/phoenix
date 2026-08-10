/**
 * `triage queue` — the claimable intake queue, oldest first, with the count it scanned.
 *
 * **`empty` and a failed read are different answers and never share a channel or a code.** The skill
 * uses this verb as a sweep's termination test, and a renamed label or a scope-limited token answers
 * HTTP 200 with `[]` — so the label's existence is checked against the repository's label set and a
 * typo reds on {@link ZERO_SCOPE} rather than reporting the queue drained.
 *
 * The filer login the read this replaces printed on every row is deliberately absent: a bare login
 * is not a provenance verdict — reaching one takes the agent footer *and* the configured operator
 * set, which is `./provenance.ts`'s job. `triage provenance` answers the question that field
 * pretends to.
 */
import {Effect} from "effect";
import {listLabels, openQueueIssues, type QueueIssue, resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {scannedLine} from "./scope.ts";

export const DEFAULT_QUEUE_LABEL = "status:needs-triage";
export const DEFAULT_QUEUE_LIMIT = 100;

const DAY_MS = 86_400_000;

export interface QueueOptions {
	readonly label: string;
	readonly limit: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

export interface QueueRow {
	readonly number: number;
	readonly ageDays: number;
	readonly title: string;
}

/** Whole days from `createdAt` to `now`, floored. A clock skew that runs the age negative reads 0. */
export const ageDays = (createdAt: string, now: Date): number =>
	Math.max(0, Math.floor((now.getTime() - Date.parse(createdAt)) / DAY_MS));

/** Oldest first — ISO-8601 UTC sorts chronologically as text, so the compare needs no parse. */
export const toRows = (
	issues: ReadonlyArray<QueueIssue>,
	now: Date,
	limit: number,
): ReadonlyArray<QueueRow> =>
	[...issues]
		.sort((a, b) =>
			a.createdAt === b.createdAt ? a.number - b.number : a.createdAt < b.createdAt ? -1 : 1,
		)
		.slice(0, limit)
		.map((issue) => ({
			number: issue.number,
			ageDays: ageDays(issue.createdAt, now),
			title: issue.title,
		}));

export const runQueue = Effect.fn("runQueue")(function* (options: QueueOptions) {
	const {label, limit, json} = options;

	if (limit < 1) return refuse(FAILED, "triage queue: --limit must be 1 or greater.");

	const repoAttempt = yield* resolveRepo(options.repo, options.env);
	if (repoAttempt._tag === "Failure") {
		return refuse(
			FAILED,
			"triage queue: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
		);
	}
	const repo = repoAttempt.value;

	// The label precondition runs BEFORE the queue read, because it is what makes the queue's scope
	// non-zero. Reading it here also means an unreadable label set refuses as UNKNOWN rather than
	// resolving to "the label is missing".
	const labels = yield* listLabels(repo);
	if (labels._tag === "Failure") {
		return refuse(
			PRECONDITION_UNKNOWN,
			`triage queue: cannot read the label set of ${repo}: ${labels.reason} — whether the ${label} queue exists is UNKNOWN, and so is the outcome.`,
		);
	}
	if (!labels.value.includes(label)) {
		return refuse(
			ZERO_SCOPE,
			`triage queue: label ${label} does not exist in ${repo} — refusing to report an empty queue over zero scope (ADR 0092).`,
			[scannedLine("triage queue", repo, labels.value.length, "label", `none of them is ${label}`)],
		);
	}

	const queue = yield* openQueueIssues(repo, label);
	if (queue._tag === "Failure") {
		// No scanned count accompanies this refusal on purpose: a count is a measurement, and a read
		// that failed produced none. Printing `scanned 0` here would be the very fusion of "nothing
		// is there" with "I could not look" that the 7/11 split exists to prevent.
		return refuse(
			PRECONDITION_UNKNOWN,
			`triage queue: cannot read the ${label} queue in ${repo}: ${queue.reason} — the outcome is UNKNOWN, never "empty".`,
		);
	}

	const scanned = queue.value.length;
	const rows = toRows(queue.value, options.now(), limit);
	const truncated = scanned > limit;
	const scope = scannedLine(
		"triage queue",
		repo,
		scanned,
		`open ${label} issue`,
		truncated ? `list TRUNCATED to --limit ${limit}` : undefined,
	);

	if (json) {
		return answer(
			JSON.stringify({
				outcome: scanned === 0 ? "empty" : "queued",
				issues: rows,
				scanned,
				truncated,
			}),
			[scope],
		);
	}
	return scanned === 0
		? answer("empty", [scope])
		: answer(
				["queued", ...rows.map((row) => `${row.number}\t${row.ageDays}\t${row.title}`)].join("\n"),
				[scope],
			);
});
