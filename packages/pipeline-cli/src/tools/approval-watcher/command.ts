/**
 * The `approval-watcher` tool — `pipeline-cli approval-watcher record|ticks`.
 *
 * `record` is the ONE verb every branch of a §CP approval-watcher tick reaches (#4292): it writes
 * that tick's derived watch set and each PR's disposition to a durable ledger issue, so a tick
 * that found nothing is as visible afterwards as one that fired. `ticks` reads them back from any
 * later session — the read that makes "did the loop run?" answerable without the agent transcript.
 *
 * `--watch` is REQUIRED, and an empty string is its meaningful value: a tick that derived an empty
 * set says so explicitly. Making it required is what stops an omitted flag from forging that claim.
 * When the board read itself could not execute, `--watch-unresolved <what failed>` records that
 * instead — the third set-level reading, so an outage never lands as a derived-empty board.
 *
 * `ApprovalWatcherLive` is baked in with `Command.provide(...)` so the registered command's
 * residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {ApprovalWatcher, ApprovalWatcherLive} from "./github.ts";
import {
	type Derivation,
	formatDisposition,
	parseDerivation,
	parseWatchSpec,
	type TickRecord,
} from "./tick-record.ts";

const ledgerFlag = Flag.integer("ledger").pipe(
	Flag.optional,
	Flag.withDescription(
		"the ledger issue to write/read (default: $PIPELINE_APPROVAL_WATCHER_LEDGER, else the open issue labelled crew-ledger:approval-watcher, else one is provisioned)",
	),
);

const watchFlag = Flag.string("watch").pipe(
	Flag.withDescription(
		"the tick's derived watch set: one `<pr>=<disposition>` per line (`;` also separates), where a disposition is `fired`, `definite-stop:<reason>`, or `unknown:<input>`. Pass an EMPTY string for a tick that derived an empty set — the flag is required so an omission cannot pose as one",
	),
);

const watchUnresolvedFlag = Flag.string("watch-unresolved").pipe(
	Flag.optional,
	Flag.withDescription(
		"record that this tick could NOT derive its watch set, naming the read that failed (e.g. `board: unreadable payload`) — the set-level analog of a per-PR `unknown:<input>`. Its PRESENCE is what makes the record say UNRESOLVED, so an outage never lands as a derived-empty board",
	),
);

const atFlag = Flag.string("at").pipe(
	Flag.optional,
	Flag.withDescription("the tick's ISO-8601 UTC instant (default: now)"),
);

const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription("the ticking session id (default: $CLAUDE_CODE_SESSION_ID)"),
);

const limitFlag = Flag.integer("limit").pipe(
	Flag.withDefault(20),
	Flag.withDescription("how many of the most recent tick records to print (newest first)"),
);

const record = Command.make(
	"record",
	{
		ledger: ledgerFlag,
		watch: watchFlag,
		watchUnresolved: watchUnresolvedFlag,
		at: atFlag,
		session: sessionFlag,
	},
	Effect.fn(function* ({ledger, watch, watchUnresolved, at, session}) {
		const {entries, malformed} = parseWatchSpec(watch);
		// Routed through `parseDerivation` rather than built inline so an empty `--watch-unresolved`
		// still records UNRESOLVED (as `unnamed input`) — the flag's presence is the claim, and a
		// truncated reason must never downgrade it to a derived set.
		const derivation = Option.match(watchUnresolved, {
			onNone: (): Derivation => ({_tag: "derived"}),
			onSome: (input) => parseDerivation(`unresolved:${input}`),
		});
		const result = yield* (yield* ApprovalWatcher).record(Option.getOrNull(ledger), {
			at: Option.getOrElse(at, () => new Date().toISOString()),
			session: Option.getOrElse(
				session,
				() => process.env.CLAUDE_CODE_SESSION_ID ?? "unstamped-session",
			),
			watch: entries,
			malformed,
			derivation,
		});
		yield* Console.log(
			JSON.stringify({ledger: result.ledger, wrote: result.write._tag, ...result.write.record}),
		);
		process.stderr.write(
			`approval-watcher: tick recorded on ledger #${result.ledger} (${result.write._tag}) — ` +
				`${describeSet(derivation, entries.length)}, ` +
				`${result.write.record.ticks} tick(s) in this record.\n`,
		);
		if (malformed.length > 0) {
			// Recorded, not dropped: the record carries the raw lines, so a mis-shaped caller is
			// visible in the ledger rather than silently shrinking the set it claims to have derived.
			process.stderr.write(
				`approval-watcher: ${malformed.length} unreadable --watch entry/entries kept verbatim in the record: ${malformed.join(", ")}\n`,
			);
		}
	}),
).pipe(
	Command.withDescription(
		"Record one approval-watcher tick durably — its derived watch set and each PR's disposition (fired / definite-stop / unknown)",
	),
);

/** The one place the three set-level readings are worded, so `record` and `ticks` cannot drift. */
const describeSet = (derivation: Derivation, size: number): string =>
	derivation._tag === "unresolved"
		? `UNRESOLVED derived watch set (${derivation.input})`
		: size === 0
			? "EMPTY derived watch set"
			: `${size} PR(s)`;

const summarize = (r: TickRecord): string =>
	`${r.firstAt} → ${r.lastAt}  ${String(r.ticks).padStart(4)} tick(s)  ` +
	(r.derivation._tag === "unresolved" || r.watch.length === 0
		? describeSet(r.derivation, r.watch.length)
		: r.watch.map((e) => `#${e.pr} ${formatDisposition(e.disposition)}`).join(", "));

const ticks = Command.make(
	"ticks",
	{ledger: ledgerFlag, limit: limitFlag},
	Effect.fn(function* ({ledger, limit}) {
		const result = yield* (yield* ApprovalWatcher).ticks(Option.getOrNull(ledger), limit);
		yield* Console.log(JSON.stringify(result));
		for (const r of result.records) process.stderr.write(`  ${summarize(r)}\n`);
		process.stderr.write(
			`approval-watcher: ${result.records.length} tick record(s) on ledger #${result.ledger}. ` +
				"A window with NO record is a window in which no tick ran — that is the one reading an empty set does not carry.\n",
		);
	}),
).pipe(
	Command.withDescription("Read the most recent approval-watcher tick records back off the ledger"),
);

export const approvalWatcherCommand = Command.make("approval-watcher").pipe(
	Command.withSubcommands([record, ticks]),
	Command.withDescription(
		"Write and read the §CP approval-watcher's durable tick records — the derived watch set and per-PR disposition of every tick, so a tick that finds nothing is as visible as one that fires",
	),
	Command.provide(ApprovalWatcherLive),
);
