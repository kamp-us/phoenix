/**
 * The `cp-bank` tool — `pipeline-cli cp-bank apply|set|check`.
 *
 *   apply --pr N --approver LOGIN   bank a §CP PR: one act (label + assign + review request)
 *   set                             the board-derived banked §CP watch set, as JSON
 *   check [--window-hours H]        RED when banked work exists and the watcher is not ticking
 *
 * `apply` and `set` are two ends of one fact: banking writes the label the derivation reads, so
 * the watch set the approval-watcher rides can no longer be a helper name with no definition
 * (#4754). `check` is the outside reader that makes a bank-without-arm loud.
 *
 * Exit codes on `check`: **0 = proven green, 1 = proven RED, 2 = UNKNOWN.** The unknown code is
 * separate on purpose — a check that could not see what it was looking for must not share an exit
 * with one that looked and disliked what it saw (the `exit-codes.ts` rule). Any other non-zero is
 * a run that never happened, never a verdict.
 */
import {Console, Effect, Layer} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {onCheckFailed} from "../../gate-fail.ts";
import {ApprovalWatcherLive} from "../approval-watcher/github.ts";
import {RepoLabelsLive} from "../vocabulary-preflight/github.ts";
import {checkArming} from "./gate.ts";
import {BankBoard, BankBoardLive} from "./github.ts";

const UNKNOWN_EXIT_CODE = 2;

const prFlag = Flag.integer("pr").pipe(Flag.withDescription("the §CP pull request to bank"));

const approverFlag = Flag.string("approver").pipe(
	Flag.withDescription("the control-plane approver's GitHub login to bank the PR against"),
);

const ledgerFlag = Flag.integer("ledger").pipe(
	Flag.optional,
	Flag.withDescription(
		"the approval-watcher ledger issue to read (default: the tool's own resolution — never provisioned by this read)",
	),
);

const windowFlag = Flag.integer("window-hours").pipe(
	Flag.withDefault(2),
	Flag.withDescription(
		"how stale the newest approval-watcher tick may be before a non-empty banked set reds",
	),
);

const apply = Command.make(
	"apply",
	{pr: prFlag, approver: approverFlag},
	Effect.fn(function* ({pr, approver}) {
		const result = yield* (yield* BankBoard).bank(pr, approver);
		yield* Console.log(JSON.stringify(result));
		process.stderr.write(
			`cp-bank: #${pr} banked to ${approver} — labelled + assigned, confirmed by read-back. ` +
				"It is now in the board-derived watch set `cp-bank set` returns.\n",
		);
	}),
).pipe(
	Command.withDescription(
		"Bank a control-plane PR as one act — apply the banked label, assign the approver, request their review — and prove it landed",
	),
);

const set = Command.make(
	"set",
	{},
	Effect.fn(function* () {
		const banked = yield* (yield* BankBoard).set();
		yield* Console.log(JSON.stringify(banked));
		process.stderr.write(
			`cp-bank: ${banked.length} banked §CP PR(s) derived from the board. An empty ARRAY is a ` +
				"derived-empty set; a non-zero exit with no stdout is a read that never ran.\n",
		);
	}),
).pipe(
	Command.withDescription(
		"Print the banked control-plane watch set derived from the board, as a JSON array — the shipped derivation the approval-watcher tick reads",
	),
);

const check = Command.make(
	"check",
	{ledger: ledgerFlag, windowHours: windowFlag},
	Effect.fn(function* ({ledger, windowHours}) {
		yield* checkArming(ledger, windowHours).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
			Effect.catchTag("CheckUnknown", (e) =>
				Effect.sync(() => {
					process.stderr.write(`${e.reason}\n`);
					process.exit(UNKNOWN_EXIT_CODE);
				}),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Fail when a non-empty banked control-plane set has no approval-watcher tick inside the window — the reader that makes an unarmed watcher visible",
	),
);

export const cpBankCommand = Command.make("cp-bank").pipe(
	Command.withSubcommands([apply, set, check]),
	Command.withDescription(
		"Bank a control-plane PR on the board, derive the banked watch set from it, and red when that set is banked with no approval-watcher ticking (#4754)",
	),
	Command.provide(Layer.mergeAll(BankBoardLive, RepoLabelsLive, ApprovalWatcherLive)),
);
