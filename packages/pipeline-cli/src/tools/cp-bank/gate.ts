/**
 * The `cp-bank check` gate — the READER that closes #4754's finding 2 ("nothing reads the ledger").
 *
 * It is deliberately a different tool from `approval-watcher`: the watcher writes the ledger, and
 * a surface that only ever writes its own trace can never notice that it stopped writing. This
 * gate consumes that trace from outside, correlating it against the board-derived banked set, and
 * it runs on a schedule (`.github/workflows/cp-bank-guard.yml`) so the correlation happens without
 * a human remembering to run `approval-watcher ticks` by hand.
 *
 * The ledger read is `ApprovalWatcher.liveness` — the tool that owns the ledger — never a second
 * copy of the ledger's shape here.
 */
import {Console, Effect, Option} from "effect";
import * as Schema from "effect/Schema";
import {ApprovalWatcher} from "../approval-watcher/github.ts";
import type {RepoLabelsError} from "../vocabulary-preflight/github.ts";
import {RepoLabels} from "../vocabulary-preflight/github.ts";
import {type ArmingVerdict, BANKED_LABEL, judge, type Liveness, renderReport} from "./cp-bank.ts";
import type {BankBoardError} from "./github.ts";
import {BankBoard} from "./github.ts";

/** A proven RED: banked work is on the board and the watcher is not ticking over it. */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/** Proven UNKNOWN — kept off `CheckFailed` so a red and an unanswered question never share a code. */
export class CheckUnknown extends Schema.TaggedErrorClass<CheckUnknown>()("CheckUnknown", {
	reason: Schema.String,
}) {}

export const checkArming = (
	ledger: Option.Option<number>,
	windowHours: number,
): Effect.Effect<
	void,
	CheckFailed | CheckUnknown | BankBoardError | RepoLabelsError,
	BankBoard | RepoLabels | ApprovalWatcher
> =>
	Effect.gen(function* () {
		const board = yield* BankBoard;
		const labels = yield* RepoLabels;
		const watcher = yield* ApprovalWatcher;
		const [banked, vocabulary, ledgerLiveness] = yield* Effect.all(
			[board.set(), labels.presence([BANKED_LABEL]), watcher.liveness(Option.getOrNull(ledger))],
			{concurrency: "unbounded"},
		);
		const liveness: Liveness =
			ledgerLiveness._tag === "ticked"
				? {_tag: "ticked", lastAt: ledgerLiveness.lastAt}
				: {_tag: "no-record"};
		const verdict: ArmingVerdict = judge({
			vocabulary,
			banked,
			liveness,
			now: new Date().toISOString(),
			windowHours,
		});
		const report = renderReport(verdict);
		switch (verdict._tag) {
			case "green":
				return yield* Console.log(report);
			case "red":
				return yield* Effect.fail(new CheckFailed({reason: report}));
			case "unknown":
				return yield* Effect.fail(new CheckUnknown({reason: report}));
		}
	});
