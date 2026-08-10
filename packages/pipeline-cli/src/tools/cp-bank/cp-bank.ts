/**
 * `cp-bank` pure core — the banking label, the board-derived watch set's shape, and the one
 * decision that makes an UN-ARMED approval-watcher observably different from an armed-and-quiet
 * one (#4754).
 *
 * Banking a §CP PR and arming the watcher were two independent acts, and the board state after
 * a bank-without-arm was byte-identical to a bank-with-arm: no error, no red check, no missing
 * artifact. PR #4742 stranded approved-and-unenqueued for 8h34m and emitted nothing. This core
 * breaks that identity from the other side — it does not try to weld the two acts together (the
 * watcher is a *loop*, so a one-shot "armed" flag would just move the same silence one level up),
 * it makes the **absence of a tick reportable**: a non-empty banked set with no ledger tick inside
 * a bounded window is a RED.
 *
 * Three-state on purpose, and the third state is the whole point. A check that cannot see what it
 * is looking for must not return a plausible value — so when the scoping label does not exist in
 * the repo at all, the empty banked set it would derive is UNKNOWN, never "nothing is banked"
 * (ADR 0092's zero-scope fail-closed; the #4272 vacuous-pass shape).
 *
 * IO-free and total; `github.ts` supplies the `gh api` REST shell and `gate.ts` the wiring.
 */
import type {VocabularyPresence} from "../vocabulary-preflight/presence.ts";

/**
 * The label that makes the banked set derivable from the board. The watch registry the design
 * rests on *is* the board, so the derivation has to key on something banking durably writes —
 * `cp-bank apply` applies this label, `cp-bank set` derives the set from it, and the
 * `vocabulary-preflight` required set asserts the adopting repo actually carries it.
 */
export const BANKED_LABEL = "status:cp-banked";

/** One banked §CP PR as the board reports it. */
export interface BankedPr {
	readonly number: number;
	readonly title: string;
}

/**
 * What the approval-watcher ledger says about the loop's liveness. `no-record` is a PROVEN
 * absence — the ledger auto-provisions on the first `record`, so a repo with no ledger, and a
 * ledger with no tick record, are the same established fact: no tick has ever run.
 */
export type Liveness =
	| {readonly _tag: "ticked"; readonly lastAt: string}
	| {readonly _tag: "no-record"};

/** Everything the verdict is a function of — no clock, no IO, so the decision is testable. */
export interface ArmingInput {
	readonly vocabulary: VocabularyPresence;
	readonly banked: ReadonlyArray<BankedPr>;
	readonly liveness: Liveness;
	readonly now: string;
	readonly windowHours: number;
}

/**
 * `unknown` is not a soft red: it says the question was never answered. Keeping it distinct is
 * what stops a repo that never adopted the label — or an unparseable timestamp — from reading as
 * a healthy "nothing banked".
 */
export type ArmingVerdict =
	| {readonly _tag: "green"; readonly detail: string; readonly banked: ReadonlyArray<BankedPr>}
	| {
			readonly _tag: "red";
			readonly detail: string;
			readonly banked: ReadonlyArray<BankedPr>;
			readonly liveness: Liveness;
			readonly windowHours: number;
	  }
	| {readonly _tag: "unknown"; readonly detail: string};

const hoursBetween = (fromIso: string, toIso: string): number | null => {
	const from = Date.parse(fromIso);
	const to = Date.parse(toIso);
	if (Number.isNaN(from) || Number.isNaN(to)) return null;
	return (to - from) / 3_600_000;
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The verdict, in the order the states have to be resolved: prove the scope exists, prove the
 * clock is readable, and only then read an empty set as "nothing banked".
 */
export const judge = (input: ArmingInput): ArmingVerdict => {
	const {vocabulary, banked, liveness, now, windowHours} = input;
	if (vocabulary._tag === "absent") {
		return {
			_tag: "unknown",
			detail:
				`the scoping label(s) ${vocabulary.missing.join(", ")} do not exist in this repo, so the ` +
				"banked set could not be derived — this is UNKNOWN, NOT an empty board. Create the label " +
				`(\`gh api -X POST repos/<owner>/<repo>/labels -f name=${BANKED_LABEL}\`) or bank through ` +
				"`pipeline-cli cp-bank apply`, which provisions it.",
		};
	}
	if (!Number.isFinite(windowHours) || windowHours <= 0) {
		return {
			_tag: "unknown",
			detail: `window must be a positive number of hours, got ${windowHours}`,
		};
	}
	if (Number.isNaN(Date.parse(now))) {
		return {_tag: "unknown", detail: `could not read the current instant (${JSON.stringify(now)})`};
	}
	if (banked.length === 0) {
		return {
			_tag: "green",
			detail: `no open PR carries \`${BANKED_LABEL}\` — nothing is banked, so nothing is owed a tick`,
			banked,
		};
	}
	if (liveness._tag === "no-record") {
		return {
			_tag: "red",
			detail:
				`${plural(banked.length, "PR")} banked awaiting a control-plane approval, and the ` +
				"approval-watcher ledger carries NO tick record at all — the watcher was never armed. " +
				"An approved §CP PR here strands with nothing to enqueue it.",
			banked,
			liveness,
			windowHours,
		};
	}
	const age = hoursBetween(liveness.lastAt, now);
	if (age === null) {
		return {
			_tag: "unknown",
			detail: `the newest tick record carries an unreadable instant (${JSON.stringify(liveness.lastAt)})`,
		};
	}
	if (age > windowHours) {
		return {
			_tag: "red",
			detail:
				`${plural(banked.length, "PR")} banked awaiting a control-plane approval, and the newest ` +
				`approval-watcher tick is ${age.toFixed(1)}h old (window ${windowHours}h) — the watcher is ` +
				"not ticking, so an approval that lands now is not enqueued by anything.",
			banked,
			liveness,
			windowHours,
		};
	}
	return {
		_tag: "green",
		detail:
			`${plural(banked.length, "PR")} banked, and the approval-watcher ticked ${age.toFixed(1)}h ` +
			`ago (window ${windowHours}h) — the loop is live over this set`,
		banked,
	};
};

const bankedRows = (banked: ReadonlyArray<BankedPr>): ReadonlyArray<string> =>
	banked.map((pr) => `  #${pr.number} ${pr.title}`);

export const renderReport = (verdict: ArmingVerdict): string => {
	switch (verdict._tag) {
		case "green":
			return [`cp-bank: GREEN — ${verdict.detail}`, ...bankedRows(verdict.banked)].join("\n");
		case "red":
			return [
				`cp-bank: RED — ${verdict.detail}`,
				...bankedRows(verdict.banked),
				"",
				"Arm the approval-watcher on the engine's self-drain loop (`pipeline-cli approval-watcher",
				"record` per tick), or unbank a PR that no longer needs an approval.",
			].join("\n");
		case "unknown":
			return `cp-bank: UNKNOWN — ${verdict.detail}`;
	}
};
