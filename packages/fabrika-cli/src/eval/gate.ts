/**
 * The merge gate — the ruled #4637-B bar as one decision, so a CI job only has to relay it (#4681).
 *
 * The bar has four legs and this module owns the judgement of all four, which is the point: ADR 0228
 * says a script relays a verb's answer and never derives the decision, so every comparison that
 * could be re-spelled in YAML lives here instead.
 *
 * **The graded leg verifies; it does not run.** The founder ruled on #4649 (comment 5153280445) that
 * no model executes inside CI — the reason recorded is cost, not principle. The review stage runs the
 * five-run graded axis and leaves a head-bound eval record (#4678, ADR 0253); this leg reads that
 * record back and compares a string and a number. So `missing` and `stale` are red conditions in
 * their own right: they are the two ways the review step can be skipped by forgetting, and absence
 * that passes is exactly the guarantee the epic exists to restore.
 *
 * **Everything else still executes here, because none of it ever needed a model.** The deterministic
 * regression floor runs its cases once through the tier (#4677), and the spend leg is arithmetic over
 * rows a meter already reconstructed (#4679).
 *
 * The trend is computed and **reported, never gating** — ADR 0252 §4 and the #4766 guardrail defer
 * its authority to block until it has been watched against a real series. Arming it is a later ADR's
 * edit to `judgeGraded`, and nothing else.
 *
 * **A leg that measured nothing never reads as a leg that passed.** `LegVerdict` carries three states
 * rather than two, and the summary names every unmeasured leg instead of absorbing it — because the
 * artifact a reader acts on is a green check, and a green check that claims a bar was met over legs
 * that ran nothing tells the same lie #4604 told, just from the reporting side rather than the
 * path-filter side. Disclosing the gap elsewhere does not change what the check says.
 *
 * Zero scope reds (ADR 0092). A change with no path, a corpus with no deterministic case, a corpus
 * case the arming sidecar accounts for neither way, and a record that measured nothing all resolve to
 * the same refusal, because a gate that could not see its own subject has proven nothing — the #4604
 * failure class, where a path filter matching nothing presented as a pass.
 */
import type {EvalRecord} from "../wire/eval-record.ts";
import {roundRate} from "../wire/eval-record.ts";
import {type HeadSha, sameHead} from "../wire/verdict-marker.ts";
import {
	ABOVE_BASELINE,
	BELOW_BAR,
	MISSING_RESULT,
	REGRESSION_FLOOR,
	STALE_HEAD,
	ZERO_SCOPE,
} from "./codes.ts";
import {cellKeyOf, cellLabel} from "./committed-scorecard.ts";
import type {BaselineComparison} from "./cost-baseline.ts";
import type {EvalRow, TieredEvalCase} from "./deterministic-tier.ts";
import {summarizeEvalRows} from "./deterministic-tier.ts";
import type {FloorCommands} from "./floor-commands.ts";
import {armedRows, pendingRows} from "./floor-commands.ts";
import type {TrendReading} from "./trend.ts";
import {renderTrendLine} from "./trend.ts";

/** #4637 ruling 2's graded bar. Changing it is a decision, not an edit. */
export const GRADED_BAR = 0.9;

/**
 * The paths whose change makes the full graded suite apply (#4637 ruling: skill changes only).
 *
 * This is the filter #4604 got wrong on the v1 side — a `packages/` anchor that excluded the skills
 * directory, so a skill change matched nothing and the gate reported green over it. It is exported
 * and parameterised so a test can re-run the decision under a deliberately mis-scoped filter and
 * watch the red become a pass; a constant folded into the matcher could not be falsified that way.
 */
export const SKILL_PATH_PREFIXES: ReadonlyArray<string> = ["claude-plugins/fabrika/skills/"];

/** The fabrika skills a changed-path set touches, by directory name, deduplicated and sorted. */
export const changedSkills = (
	paths: ReadonlyArray<string>,
	prefixes: ReadonlyArray<string> = SKILL_PATH_PREFIXES,
): ReadonlyArray<string> => {
	const names = new Set<string>();
	for (const path of paths) {
		for (const prefix of prefixes) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length).split("/")[0];
			if (name !== undefined && name !== "") names.add(name);
		}
	}
	return [...names].sort();
};

/** The six ruled red conditions. Each names why the change is refused; none is a bare failure. */
export type GateReason =
	| "zero-scope"
	| "regression-floor"
	| "missing"
	| "stale"
	| "below-bar"
	| "over-baseline";

/**
 * Which reason seats the exit code when more than one fires.
 *
 * Every reason is still printed — the order decides only the single number `$?` can carry, and it
 * runs most-fundamental-first: a gate that could not see its scope has not established the others.
 */
export const REASON_PRECEDENCE: ReadonlyArray<GateReason> = [
	"zero-scope",
	"regression-floor",
	"missing",
	"stale",
	"below-bar",
	"over-baseline",
];

/**
 * The exit seat each reason answers on. Four are reused rather than re-seated: `7`, `15` and `18`
 * already mean exactly these facts elsewhere in the group, and a second number for one fact is how
 * a caller comes to read two codes as two outcomes.
 */
export const REASON_CODES: Readonly<Record<GateReason, number>> = {
	"zero-scope": ZERO_SCOPE,
	"regression-floor": REGRESSION_FLOOR,
	missing: MISSING_RESULT,
	stale: STALE_HEAD,
	"below-bar": BELOW_BAR,
	"over-baseline": ABOVE_BASELINE,
};

export interface GateRed {
	readonly reason: GateReason;
	readonly detail: string;
}

export type GateLeg = "scope" | "floor" | "graded" | "spend";

/**
 * One leg's answer — **three** states, and the third is the one a green check hides.
 *
 * A leg that measured nothing (an unarmed floor, a graded leg with no skill in the change, a spend
 * leg with no candidate ledger) raised no red, but it also established nothing. Folding it into the
 * same `red: null` as a leg that ran and passed is what lets a summary line say the bar is met over
 * a bar nobody measured — the #4604 shape this gate exists to end, arriving from the reporting side
 * instead of the path-filter side. So `unmeasured` is its own state, it carries the short reason the
 * summary prints, and `renderGate` may never absorb it into a met-the-bar sentence.
 */
export type LegVerdict =
	| {readonly leg: GateLeg; readonly status: "measured"; readonly line: string; readonly red: null}
	| {
			readonly leg: GateLeg;
			readonly status: "unmeasured";
			readonly line: string;
			/** What was not measured, in a clause the summary can list. */
			readonly notMeasured: string;
			readonly red: null;
	  }
	| {
			readonly leg: GateLeg;
			readonly status: "red";
			readonly line: string;
			readonly red: GateRed;
	  };

const measured = (leg: GateLeg, line: string): LegVerdict => ({
	leg,
	status: "measured",
	line,
	red: null,
});

const unmeasured = (leg: GateLeg, line: string, notMeasured: string): LegVerdict => ({
	leg,
	status: "unmeasured",
	line: `${leg}: NOT MEASURED — ${line}`,
	notMeasured,
	red: null,
});

const red = (leg: GateLeg, reason: GateReason, detail: string): LegVerdict => ({
	leg,
	status: "red",
	line: `${leg}: RED (${reason}) — ${detail}`,
	red: {reason, detail},
});

/** The scope leg: what the gate is judging over, and the refusal when that is nothing. */
export const judgeScope = (changed: ReadonlyArray<string>): LegVerdict =>
	changed.length === 0
		? red(
				"scope",
				"zero-scope",
				"the change declares no path — a gate that cannot see its own subject proves nothing (ADR 0092)",
			)
		: measured("scope", `scope: ${changed.length} changed path(s)`);

/** How the floor's cases divide against the arming sidecar. */
export interface FloorScope {
	readonly armed: ReadonlyArray<TieredEvalCase>;
	readonly pending: ReadonlyArray<number>;
	/** Deterministic cases the sidecar accounts for neither way — an arming decision nobody made. */
	readonly unaccounted: ReadonlyArray<number>;
}

/**
 * Split the corpus's deterministic cases into what the floor runs and what it admits it cannot.
 *
 * Graded cases are not this leg's: they carry a written rationale in the corpus provenance and are
 * the review stage's to run, so they are neither armed nor owed a pending row here.
 */
export const floorScope = (
	cases: ReadonlyArray<TieredEvalCase>,
	sidecar: FloorCommands,
): FloorScope => {
	const armedIds = armedRows(sidecar);
	const pendingIds = pendingRows(sidecar);
	const armed: Array<TieredEvalCase> = [];
	const pending: Array<number> = [];
	const unaccounted: Array<number> = [];
	for (const evalCase of cases) {
		if (evalCase.tier !== "deterministic") continue;
		if (armedIds.has(evalCase.id)) armed.push(evalCase);
		else if (pendingIds.has(evalCase.id)) pending.push(evalCase.id);
		else unaccounted.push(evalCase.id);
	}
	return {armed, pending, unaccounted};
};

/**
 * The regression floor: 100%, no tolerance and no quarantine over the cases the floor runs.
 *
 * `summarizeEvalRows` is the one aggregator and it already reds an empty row set, an `uncheckable`
 * case and a `flake` — none of which is tolerated into green — so this leg reads its verdict rather
 * than re-deriving a pass rate the tier already computed.
 */
export const judgeFloor = (args: {
	readonly scope: FloorScope;
	readonly rows: ReadonlyArray<EvalRow>;
	readonly deterministicCases: number;
}): LegVerdict => {
	if (args.deterministicCases === 0) {
		return red(
			"floor",
			"zero-scope",
			"the incident corpus carries no deterministic case — the regression floor would measure nothing (ADR 0092)",
		);
	}
	if (args.scope.unaccounted.length > 0) {
		return red(
			"floor",
			"zero-scope",
			`the arming sidecar accounts for neither running nor deferring case(s) ${args.scope.unaccounted.join(", ")} — a corpus case with no arming decision silently leaves the floor`,
		);
	}
	const pending =
		args.scope.pending.length === 0
			? ""
			: `; ${args.scope.pending.length} case(s) pending arming (${args.scope.pending.join(", ")})`;
	// An all-pending floor is reported on every run, not red — and the distinction from zero scope is
	// the one a reader is most likely to collapse. Zero scope is a corpus the gate could not see; this
	// is a corpus it can see, whose every case carries a committed, written statement of what is owed
	// before it can run. Nothing failing is being excluded, so this is not the quarantine the ruled
	// floor forbids. It is still `unmeasured` and never `measured`: no regression can red a floor that
	// runs nothing, so the summary has to say so out loud.
	if (args.scope.armed.length === 0) {
		return unmeasured(
			"floor",
			`no incident case is armed to run yet, so no incident regression can red this gate${pending}`,
			`floor (0 of ${args.scope.pending.length} incident case(s) armed — no regression can red it)`,
		);
	}
	const summary = summarizeEvalRows(args.rows);
	if (summary.verdict === "red") {
		return red(
			"floor",
			"regression-floor",
			`${summary.redReason ?? "the suite is red"} — the floor is 100%, with no tolerance and no quarantine`,
		);
	}
	return measured(
		"floor",
		`floor: ${summary.total.passed}/${summary.total.cases} armed incident case(s) pass${pending}`,
	);
};

/** The latest record per `(stage × surface × model)` cell, by the stamp the record carries. */
export const latestPerCell = (records: ReadonlyArray<EvalRecord>): ReadonlyArray<EvalRecord> => {
	const latest = new Map<string, EvalRecord>();
	for (const record of records) {
		const key = cellKeyOf(record.payload.cell);
		const held = latest.get(key);
		if (held === undefined || held.payload.recordedAt <= record.payload.recordedAt) {
			latest.set(key, record);
		}
	}
	return [...latest.values()].sort((a, b) =>
		cellLabel(a.payload.cell).localeCompare(cellLabel(b.payload.cell)),
	);
};

/**
 * Where the measurement this leg reads back is taken, named in both reds that a run cures.
 *
 * `missing` and `stale` are recoverable states, not terminal failures, and neither is a blocker the
 * build lane that tripped it can clear: the harness's worktree-isolation guard refuses the eval
 * runner inside a lane outright (#5406, not fixable in this repo), so a graded run executes in a
 * plain non-worktree session. A red that names no run site reads as "this lane is broken" and a red
 * that says only "re-run the suite" names a cure the lane structurally cannot perform — so both name
 * the site, and the hand-off, here. Stated once; both details point at it.
 */
const GRADED_RUN_SITE =
	"cure: take a graded run at the head under gate in a plain, non-worktree session — never inside a build lane, whose harness refuses the runner (#5406) — which posts the head-bound record this leg reads back. A lane that hits this hands the measurement off; it is not the lane's to fix in place";

/**
 * The graded leg: verify the recorded head-bound result, and never run anything.
 *
 * The resolution is the shared gate-verdict contract's, reused rather than re-invented — latest
 * result wins per cell, then a refusal when that latest is not bound to the head under gate. A
 * measurement is re-run at the new head, never re-bound to it.
 */
export const judgeGraded = (args: {
	readonly changedSkills: ReadonlyArray<string>;
	readonly records: ReadonlyArray<EvalRecord>;
	readonly head: HeadSha;
	readonly bar?: number;
}): LegVerdict => {
	const bar = args.bar ?? GRADED_BAR;
	if (args.changedSkills.length === 0) {
		return unmeasured(
			"graded",
			"n/a — this change touches no fabrika skill, so no graded rate was read",
			"graded (n/a — this change touches no fabrika skill)",
		);
	}
	const skills = args.changedSkills.join(", ");
	if (args.records.length === 0) {
		return red(
			"graded",
			"missing",
			`${skills} changed and no eval record was recorded for ${args.head} — absence is never "nothing to check" (#4649 ruling). ${GRADED_RUN_SITE}`,
		);
	}

	const latest = latestPerCell(args.records);
	const atHead = latest.filter((record) => sameHead(record.sha, args.head));
	if (atHead.length === 0) {
		const newest = [...latest].sort((a, b) =>
			a.payload.recordedAt.localeCompare(b.payload.recordedAt),
		)[latest.length - 1];
		return red(
			"graded",
			"stale",
			`the newest eval record is bound to ${newest?.sha ?? "an unreadable head"}, not to ${args.head} — a measurement is re-run at the new head, never re-bound to it (ADR 0253). ${GRADED_RUN_SITE}`,
		);
	}

	const unrecordable = atHead.filter((record) => record.outcome !== "RECORDED");
	if (unrecordable.length > 0) {
		return red(
			"graded",
			"zero-scope",
			`the record for ${cellLabel(unrecordable[0]?.payload.cell ?? {stage: "?", surface: null, model: "?"})} at ${args.head} is UNRECORDABLE — a run that measured nothing is broken, not green (ADR 0092)`,
		);
	}

	const below = atHead.filter((record) => roundRate(record.payload.passRate) < bar);
	if (below.length > 0) {
		const worst = below
			.map((record) => `${cellLabel(record.payload.cell)} at ${record.payload.passRate}`)
			.join(", ");
		return red("graded", "below-bar", `${worst} — the ruled bar is ${bar} (#4637 ruling 2)`);
	}
	return measured(
		"graded",
		`graded: ${atHead.length} cell(s) recorded at ${args.head}, all at or above ${bar} (skills: ${skills})`,
	);
};

/** What the spend leg was handed: a comparison, or the named reason there is none to make. */
export type SpendInput =
	| {readonly _tag: "Compared"; readonly comparison: BaselineComparison}
	| {readonly _tag: "NoLedger"; readonly path: string}
	| {readonly _tag: "NoBaseline"; readonly dir: string};

/**
 * The spend leg: at or below the committed v1 baseline on the same corpus (#4637 ruling 3).
 *
 * `incomparable` reds with the others rather than beside them — it is what stops a candidate that
 * quietly priced a different case set from reading as a cheaper one — and its detail says which of
 * the two it was, since the remedies differ (a cost regression to fix, versus a measurement to redo).
 *
 * A missing ledger is **not** a red. The ledger is a suite run's artifact and CI runs no suite, so
 * its absence means no candidate spend was measured on this change — reported by name, never folded
 * into a pass. A ledger with no baseline to price it against is the other way round and reds: a
 * measurement with no ceiling cannot be judged.
 */
export const judgeSpend = (input: SpendInput): LegVerdict => {
	if (input._tag === "NoLedger") {
		return unmeasured(
			"spend",
			`not-priced — no candidate spend ledger at ${input.path}; CI runs no suite of its own, so no spend was priced against the v1 baseline`,
			"spend (not-priced — CI ran no suite, so nothing was priced against the v1 baseline)",
		);
	}
	if (input._tag === "NoBaseline") {
		return red(
			"spend",
			"zero-scope",
			`a candidate spend ledger was read and ${input.dir} carries no committed v1 baseline to price it against`,
		);
	}
	const {comparison} = input;
	if (comparison.verdict === "at-or-below") {
		return measured(
			"spend",
			`spend: at-or-below — ${comparison.candidateBilled} billed against the v1 baseline's ${comparison.baselineBilled}`,
		);
	}
	return red(
		"spend",
		"over-baseline",
		`${comparison.verdict}: ${comparison.reason} (#4679 prices the same corpus on both sides)`,
	);
};

export interface GateVerdict {
	readonly verdict: "green" | "red";
	readonly reds: ReadonlyArray<GateRed>;
	/** The seat `$?` carries: the highest-precedence red, or `0`. */
	readonly code: number;
	readonly legs: ReadonlyArray<LegVerdict>;
	/** The advisory trend lines. They never change `verdict` or `code` (ADR 0252 §4). */
	readonly advisories: ReadonlyArray<string>;
}

/** Fold the legs into one answer. Every red is carried; one of them seats the exit code. */
export const decideGate = (args: {
	readonly legs: ReadonlyArray<LegVerdict>;
	readonly trend?: ReadonlyArray<TrendReading>;
}): GateVerdict => {
	const reds = args.legs.flatMap((leg) => (leg.red === null ? [] : [leg.red]));
	const seat = REASON_PRECEDENCE.find((reason) => reds.some((r) => r.reason === reason));
	const advisories = (args.trend ?? []).map((reading) =>
		renderTrendLine(reading.series, reading.result),
	);
	return {
		verdict: reds.length === 0 ? "green" : "red",
		reds,
		code: seat === undefined ? 0 : REASON_CODES[seat],
		legs: args.legs,
		advisories,
	};
};

/** What the legs that measured nothing were not measuring — empty when the bar was measured whole. */
export const unmeasuredLegs = (verdict: GateVerdict): ReadonlyArray<string> =>
	verdict.legs.flatMap((leg) => (leg.status === "unmeasured" ? [leg.notMeasured] : []));

/**
 * The summary line — the one sentence a reader skimming a green check actually reads.
 *
 * It never says the bar is met unless every leg measured: an unmeasured leg is named in the line
 * itself, so the check cannot be read as an enforcement it did not perform.
 */
const summaryLine = (verdict: GateVerdict): string => {
	if (verdict.verdict === "red") {
		return `gate: RED — ${verdict.reds.map((r) => r.reason).join(", ")}`;
	}
	const unmeasured = unmeasuredLegs(verdict);
	if (unmeasured.length === 0) {
		return `gate: GREEN — all ${verdict.legs.length} leg(s) of the ruled bar were measured and met`;
	}
	const met = verdict.legs.flatMap((leg) => (leg.status === "measured" ? [leg.leg] : []));
	return [
		`gate: NOT FULLY MEASURED — nothing red, and ${unmeasured.length} of ${verdict.legs.length} leg(s) measured NOTHING,`,
		` so this is not a statement that the bar is met. NOT MEASURED: ${unmeasured.join("; ")}.`,
		` Measured and met: ${met.length === 0 ? "no leg" : met.join(", ")}.`,
	].join("");
};

/** The human report — one line per leg, then the advisories, then the summary. */
export const renderGate = (verdict: GateVerdict): string =>
	[
		"fabrika eval gate — judged against the #4637-B bar (100% floor · 90% graded · spend ≤ v1 baseline)",
		...verdict.legs.map((leg) => leg.line),
		...verdict.advisories,
		summaryLine(verdict),
	].join("\n");

/** The machine-readable form, for a caller that wants the reasons without parsing prose. */
export const gateToJson = (verdict: GateVerdict): string =>
	`${JSON.stringify(
		{
			verdict: verdict.verdict,
			code: verdict.code,
			bar: {graded: GRADED_BAR, floor: 1, adr: 4637},
			reds: verdict.reds,
			unmeasured: unmeasuredLegs(verdict),
			legs: verdict.legs.map((leg) => ({
				leg: leg.leg,
				status: leg.status,
				line: leg.line,
				red: leg.red,
			})),
			advisories: verdict.advisories,
		},
		null,
		2,
	)}\n`;
