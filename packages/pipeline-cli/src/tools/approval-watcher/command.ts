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
 *
 * `ApprovalWatcherLive` is baked in with `Command.provide(...)` so the registered command's
 * residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {ApprovalWatcher, ApprovalWatcherLive} from "./github.ts";
import {formatDisposition, parseWatchSpec, type TickRecord} from "./tick-record.ts";

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
	{ledger: ledgerFlag, watch: watchFlag, at: atFlag, session: sessionFlag},
	Effect.fn(function* ({ledger, watch, at, session}) {
		const {entries, malformed} = parseWatchSpec(watch);
		const result = yield* (yield* ApprovalWatcher).record(Option.getOrNull(ledger), {
			at: Option.getOrElse(at, () => new Date().toISOString()),
			session: Option.getOrElse(
				session,
				() => process.env.CLAUDE_CODE_SESSION_ID ?? "unstamped-session",
			),
			watch: entries,
			malformed,
		});
		yield* Console.log(
			JSON.stringify({ledger: result.ledger, wrote: result.write._tag, ...result.write.record}),
		);
		process.stderr.write(
			`approval-watcher: tick recorded on ledger #${result.ledger} (${result.write._tag}) — ` +
				`${entries.length === 0 ? "EMPTY derived watch set" : `${entries.length} PR(s)`}, ` +
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

const summarize = (r: TickRecord): string =>
	`${r.firstAt} → ${r.lastAt}  ${String(r.ticks).padStart(4)} tick(s)  ` +
	(r.watch.length === 0
		? "EMPTY derived watch set"
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
