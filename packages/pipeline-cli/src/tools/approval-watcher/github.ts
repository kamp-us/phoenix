/**
 * The `gh api` REST shell behind `approval-watcher record|ticks` — the durable surface the tick
 * record lands on, and the read that gets it back after the writing session is gone.
 *
 * **The surface is a dedicated ledger issue, never the watched PR.** A §CP PR's thread is where a
 * human reads an approval decision, and the watcher ticks on the engine's self-drain loop, so a
 * per-tick-per-PR comment would flood it (#4292 constraint 2). The ledger is one board issue
 * carrying the label `crew-ledger:approval-watcher`: off every human review thread, readable by
 * plain `gh api repos/<repo>/issues/<n>/comments`, and durable by construction.
 *
 * **Noise is bounded by coalescing, not by writing less.** Every tick writes; consecutive ticks
 * that derived the same set with the same dispositions patch one comment and bump its count
 * (`planTickWrite`), so an idle watcher costs one comment that keeps a live `ticks`/`lastAt`
 * instead of one comment per tick. Two engines ticking concurrently can lose a count to
 * last-write-wins on that patch — an accepted trade: the span and the set stay right, which is
 * what a diagnosis reads.
 *
 * Same `Context.Service`-on-`ChildProcessSpawner` shape as `claim/github.ts`: REST only (GraphQL
 * is broken on the kamp-us org), every infra failure a typed error in the `E` channel
 * (`.patterns/effect-errors.md`), untrusted REST JSON Schema-decoded at the boundary.
 */
import {Context, Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcessSpawner} from "effect/unstable/process";
import {
	decodeComments,
	type GhCommandError,
	type GhParseError,
	json,
	listCommentsArgs,
	patchCommentArgs,
	postCommentArgs,
	type RepoResolutionError,
	resolveRepo,
	runGh,
} from "../tracker/gh-io.ts";
import {
	type LatestTick,
	parseTick,
	planTickWrite,
	type TickInput,
	type TickRecord,
	type TickWrite,
} from "./tick-record.ts";

/** The label that identifies the ledger issue — the only thing that makes it discoverable. */
export const LEDGER_LABEL = "crew-ledger:approval-watcher";
const LEDGER_TITLE = "approval-watcher tick ledger";
const LEDGER_BODY = [
	"Durable tick records for the §CP approval-watcher (#4292).",
	"",
	"Each comment is one tick outcome: the watch set that tick derived from the board and each PR's",
	"disposition (`fired` / `definite-stop:<reason>` / `unknown:<input>`), or UNRESOLVED when that",
	"board read could not execute at all. Consecutive ticks with the",
	"same outcome coalesce into one comment with a tick count and a first→last span, so an idle",
	"watcher stays cheap. No record at all across a window means no tick ran in it.",
	"",
	"Machine-written by `pipeline-cli approval-watcher record`; read with",
	"`pipeline-cli approval-watcher ticks`. Not a discussion thread.",
].join("\n");

const RawIssue = Schema.Struct({number: Schema.Number});
const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(RawIssue));
const decodeIssue = Schema.decodeUnknownEffect(RawIssue);

const searchLedgerArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues?state=open&per_page=100&labels=${encodeURIComponent(LEDGER_LABEL)}`,
];

const createLabelArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/labels`,
	"-f",
	`name=${LEDGER_LABEL}`,
	"-f",
	"color=ededed",
	"-f",
	"description=Machine-written crew loop tick ledger — not a discussion thread",
];

const createLedgerArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"POST",
	`repos/${repo}/issues`,
	"-f",
	`title=${LEDGER_TITLE}`,
	"-f",
	`body=${LEDGER_BODY}`,
	"-f",
	`labels[]=${LEDGER_LABEL}`,
];

/**
 * Locate the ledger issue WITHOUT creating one: an explicit number wins, then
 * `$PIPELINE_APPROVAL_WATCHER_LEDGER`, then the label search — and `null` when none exists.
 * The read path stops here (a guard must not mint board state); only `resolveLedger` provisions.
 */
const findLedger = Effect.fn("ApprovalWatcher.findLedger")(function* (
	repo: string,
	explicit: number | null,
) {
	if (explicit !== null) return explicit;
	const fromEnv = Number(process.env.PIPELINE_APPROVAL_WATCHER_LEDGER ?? "");
	if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
	const found = yield* decodeIssues(yield* json(searchLedgerArgs(repo)));
	return found[0]?.number ?? null;
});

/**
 * Resolve the ledger issue, provisioning one if none exists. Auto-provisioning is deliberate and
 * bounded to one issue ever — the alternative is a first tick that has nowhere to write and
 * therefore silently records nothing, which is the defect this tool exists to remove.
 */
const resolveLedger = Effect.fn("ApprovalWatcher.resolveLedger")(function* (
	repo: string,
	explicit: number | null,
) {
	const existing = yield* findLedger(repo, explicit);
	if (existing !== null) return existing;
	// The label may or may not exist; a 422 here is "already exists", which is not a failure.
	yield* runGh(createLabelArgs(repo)).pipe(
		Effect.catchTag("@kampus/gh-io/GhCommandError", () => Effect.void),
	);
	const created = yield* decodeIssue(yield* json(createLedgerArgs(repo)));
	return created.number;
});

const ledgerComments = Effect.fn("ApprovalWatcher.ledgerComments")(function* (
	repo: string,
	ledger: number,
) {
	const raw = yield* decodeComments(yield* json(listCommentsArgs(repo, ledger)));
	return raw.map((c) => ({id: c.id, createdAt: c.created_at, body: c.body ?? ""}));
});

/** The newest comment on the ledger that parses as a tick record — the coalescing candidate. */
const latestTick = (
	comments: ReadonlyArray<{readonly id: number; readonly body: string}>,
): LatestTick | null => {
	for (let i = comments.length - 1; i >= 0; i--) {
		const comment = comments[i];
		if (comment === undefined) continue;
		const record = parseTick(comment.body);
		if (record !== null) return {commentId: comment.id, record};
	}
	return null;
};

/** What a `record` run did: where it wrote, and the record as it now stands on the ledger. */
export interface RecordResult {
	readonly ledger: number;
	readonly write: TickWrite;
}

const record = Effect.fn("ApprovalWatcher.record")(function* (
	repo: string,
	explicitLedger: number | null,
	tick: TickInput,
) {
	const ledger = yield* resolveLedger(repo, explicitLedger);
	const write = planTickWrite(latestTick(yield* ledgerComments(repo, ledger)), tick);
	yield* write._tag === "coalesce"
		? runGh(patchCommentArgs(repo, write.commentId, write.body))
		: runGh(postCommentArgs(repo, ledger, write.body));
	return {ledger, write} satisfies RecordResult;
});

/** What a `ticks` read found: the ledger it read, and the records newest-first. */
export interface TicksResult {
	readonly ledger: number;
	readonly records: ReadonlyArray<TickRecord>;
}

const ticks = Effect.fn("ApprovalWatcher.ticks")(function* (
	repo: string,
	explicitLedger: number | null,
	limit: number,
) {
	const ledger = yield* resolveLedger(repo, explicitLedger);
	const comments = yield* ledgerComments(repo, ledger);
	const records = comments
		.map((c) => parseTick(c.body))
		.filter((r): r is TickRecord => r !== null)
		.reverse()
		.slice(0, limit);
	return {ledger, records} satisfies TicksResult;
});

/**
 * The ledger's liveness as an OUTSIDE reader sees it — the single-sourced answer to "has the
 * watcher ticked, and when?" (#4754). Both non-`ticked` arms are a proven absence, not an
 * unknown: the ledger auto-provisions on the first `record`, so no ledger and a ledger with no
 * record both establish that no tick has ever run.
 */
export type LedgerLiveness =
	| {readonly _tag: "no-ledger"}
	| {readonly _tag: "no-record"; readonly ledger: number}
	| {readonly _tag: "ticked"; readonly ledger: number; readonly lastAt: string};

/**
 * The newest tick instant across the ledger, NOT the last comment's — coalescing patches an
 * older comment and bumps its `lastAt`, so recency lives in the max, never in comment order.
 */
const liveness = Effect.fn("ApprovalWatcher.liveness")(function* (
	repo: string,
	explicitLedger: number | null,
) {
	const ledger = yield* findLedger(repo, explicitLedger);
	if (ledger === null) return {_tag: "no-ledger"} satisfies LedgerLiveness;
	const records = (yield* ledgerComments(repo, ledger))
		.map((c) => parseTick(c.body))
		.filter((r): r is TickRecord => r !== null);
	let lastAt: string | null = null;
	for (const record of records) {
		if (lastAt === null || record.lastAt > lastAt) lastAt = record.lastAt;
	}
	return (
		lastAt === null ? {_tag: "no-record", ledger} : {_tag: "ticked", ledger, lastAt}
	) satisfies LedgerLiveness;
});

type Fault = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

/**
 * `ApprovalWatcher` — the IO shell over `gh api` REST behind the two verbs: `record` (write one
 * tick's outcome durably) and `ticks` (read the last N back, from any session).
 */
export class ApprovalWatcher extends Context.Service<
	ApprovalWatcher,
	{
		readonly record: (ledger: number | null, tick: TickInput) => Effect.Effect<RecordResult, Fault>;
		readonly ticks: (ledger: number | null, limit: number) => Effect.Effect<TicksResult, Fault>;
		readonly liveness: (ledger: number | null) => Effect.Effect<LedgerLiveness, Fault>;
	}
>()("@kampus/approval-watcher/ApprovalWatcher") {}

export const ApprovalWatcherLive: Layer.Layer<
	ApprovalWatcher,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(ApprovalWatcher)(
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E>(
			effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
		) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
		const repo = yield* Effect.cached(withSpawner(resolveRepo()));
		return {
			record: (ledger: number | null, tick: TickInput) =>
				repo.pipe(Effect.flatMap((r) => withSpawner(record(r, ledger, tick)))),
			ticks: (ledger: number | null, limit: number) =>
				repo.pipe(Effect.flatMap((r) => withSpawner(ticks(r, ledger, limit)))),
			liveness: (ledger: number | null) =>
				repo.pipe(Effect.flatMap((r) => withSpawner(liveness(r, ledger)))),
		};
	}),
);
