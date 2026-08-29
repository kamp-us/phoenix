/**
 * `ship checks` — the head CI rollup, with the running-vs-wedged split and the zero-checkset facts.
 *
 * The rollup itself is **the shipped `review ci` module, extended rather than forked**
 * (`../review/rollup.ts`): same bucket rules, same fail-closed direction on the ambiguous rows. This
 * group adds two things on top — the wedge diagnosis and the ADR 0061 informational carve-out — and
 * both live in that same module so a second copy cannot drift the way v1's two `jq` copies did.
 *
 * `no-runs` is a **positively evidenced** state, not an empty read: workflows ≥ 1 and zero runs at
 * this head means Actions exist and none fired, which is the dropped-trigger state `ship nudge`
 * re-derives for itself. Zero workflows is `no-producer` — a different fact from `pending`, and no
 * longer collapsed into it (#6298): a repo with no CI is not a repo whose CI is still running, and
 * printing the second over the first tells an operator to wait for a run nothing will ever start.
 *
 * A `green` is served only over bytes a gate of this repo's own inspected: the coverage read is
 * `../review/gate-coverage.ts`, the same module `review ci` refuses on, and a head where every
 * repo-authored workflow was silent refuses on {@link NO_GATE_COVERAGE} rather than printing the
 * word this group merges on (#6915).
 */
import {Clock, Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {producerFor, resolveCi} from "../config/ci-producer.ts";
import {reasonHistogram} from "../evidence.ts";
import {commitExists} from "../io/pulls.ts";
import {gateCoverageOf} from "../review/gate-coverage.ts";
import {isFailing, isInformational, isStalled, rollupOf, statusOf} from "../review/rollup.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, NO_GATE_COVERAGE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	latestPerContext,
	listRunsAtHead,
	listShipCheckRuns,
	listWorkflowPaths,
	type ShipCheckRun,
} from "./github.ts";
import {isSuperseded, supersededSuites} from "./supersession.ts";
import {
	badNumber,
	inspectedSha,
	prefixMatch,
	resolvePull,
	resolveTargetRepo,
	scannedLine,
} from "./target.ts";

const VERB = "ship checks";

export type ChecksRollup = "green" | "red" | "pending" | "wedged" | "no-runs" | "no-producer";
export type Settle = "settled" | "budget-exhausted" | "head-moved";

export interface ChecksOptions {
	readonly pr: number;
	readonly sha: string;
	readonly wait: boolean;
	readonly budgetSeconds: number;
	readonly cadenceSeconds: number;
	readonly wedgeDwellSeconds: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Where `.fabrika.jsonc` is looked for — the repo root above it, per `config/working-root.ts`. */
	readonly cwd: string;
}

/**
 * The histogram key one check run tallies under: its status composed with whether it gates.
 *
 * `checks` is an evidence-array under ADR 0308 — the skill routes off the rollup, never off a row —
 * so it collapses to counts. The two names the skill's own terminals do read, the wedged run and the
 * failing gating run, ride the notes channel instead, so `red` still routes to `heal-ci` by name.
 * The gating axis rides inside the key because status
 * alone would leave the rollup underivable from the payload: a `red` head and a head whose only
 * `failure` is an ADR 0061 informational run would tally identically, and the carve-out is exactly
 * what separates them. A superseded cancel says so in the key for the same reason — it pends where a
 * plain `cancelled` reds.
 */
const checkClassOf = (run: ShipCheckRun, superseded: ReadonlySet<number>): string => {
	const status = isSuperseded(run, superseded) ? `${statusOf(run)}-superseded` : statusOf(run);
	return `${status}/${isInformational(run.name) ? "informational" : "gating"}`;
};

export interface Sample {
	readonly runs: ReadonlyArray<ShipCheckRun>;
	/**
	 * The repo's active workflow inventory, path-addressed.
	 *
	 * Paths rather than the count it used to be: the count is `no-producer`'s discriminator and the
	 * paths are the gate-coverage read's left operand, and holding both would be one fact stored twice.
	 */
	readonly workflows: ReadonlyArray<string>;
	readonly runCount: number;
	/** The workflows that produced a run at this head — gate coverage's right operand. */
	readonly ranAtHead: ReadonlyArray<string>;
	/** The suites a newer run of their own workflow replaced at this head — see `./supersession.ts`. */
	readonly superseded: ReadonlySet<number>;
}

/** The gating check runs a superseded suite cancelled — read as still in flight, never as failed. */
const supersededGating = (sample: Sample): ReadonlyArray<ShipCheckRun> =>
	sample.runs.filter((run) => !isInformational(run.name) && isSuperseded(run, sample.superseded));

/**
 * The whole answer over one sample.
 *
 * `stalled` is passed in rather than computed here because the dwell is a property of the *watch*,
 * not of the sample: a single read cannot tell a check that queued a second ago from one wedged for
 * an hour.
 */
export const rollupFor = (sample: Sample, wedged: ReadonlyArray<string>): ChecksRollup => {
	if (wedged.length > 0) return "wedged";
	if (sample.runs.length === 0) {
		if (sample.workflows.length === 0) return "no-producer";
		return sample.runCount === 0 ? "no-runs" : "pending";
	}
	const gating = sample.runs.filter((run) => !isInformational(run.name));
	const rollup = rollupOf(gating.filter((run) => !isSuperseded(run, sample.superseded)));
	// A superseded cancel is exactly as unfinished as a running check, so it pends a green and loses
	// to a red — the substitution `rollupOf` would make if the row were still in flight.
	return rollup === "green" && supersededGating(sample).length > 0 ? "pending" : rollup;
};

export const runChecks = (
	options: ChecksOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		const bound = inspectedSha(VERB, options.sha);
		if (typeof bound !== "string") return bound;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const unreadable = (what: string, reason: string): string =>
			`${VERB}: cannot enumerate ${what} at ${bound}: ${reason} — CI state is UNKNOWN, never green.`;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => unreadable("the pull request", reason),
		});
		if (target._tag === "Refused") return target.outcome;

		const at = yield* commitExists(repo, bound);
		if (at._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: no commit ${bound} on PR #${pr}.`);
		}
		if (at._tag === "Unknown") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the commit", at.reason));
		}

		const diagnostics: string[] = [];
		if (!prefixMatch(target.pull.headSha, bound)) {
			diagnostics.push(
				`${VERB}: the live head is ${target.pull.headSha}, you are enumerating ${bound} — the head moved.`,
			);
		}

		/** One full read of the head's CI surface. Every leg's exit status is read before its bytes. */
		const sample = Effect.gen(function* () {
			const enumerated = yield* listShipCheckRuns(repo, bound);
			if (enumerated._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					unreadable("the check runs", enumerated.reason),
					diagnostics,
				);
			}
			const {declared, runs} = enumerated.value;
			if (runs.length < declared) {
				return refuse(
					INCOMPLETE_SCAN,
					`${VERB}: received ${runs.length} of ${declared} declared check runs at ${bound} — refusing the partial enumeration.`,
					diagnostics,
				);
			}
			const workflows = yield* listWorkflowPaths(repo);
			if (workflows._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					unreadable("the workflow inventory", workflows.reason),
					diagnostics,
				);
			}
			// Enumerated rather than counted: `total_count` is still the `no-runs` discriminator, and
			// the rows beside it are the only place supersession can be read from (#6834).
			const atHead = yield* listRunsAtHead(repo, bound);
			if (atHead._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					unreadable("the workflow runs", atHead.reason),
					diagnostics,
				);
			}
			return {
				runs: latestPerContext(runs),
				workflows: workflows.value,
				runCount: atHead.value.declared,
				ranAtHead: atHead.value.runs.map((run) => run.path),
				superseded: supersededSuites(atHead.value.runs),
			} satisfies Sample;
		});

		const render = (
			read: Sample,
			rollup: ChecksRollup,
			wedged: ReadonlyArray<string>,
			settle: Settle | null,
			notes: ReadonlyArray<string> = [],
		): VerbOutcome => {
			const failing = read.runs
				.filter(
					(run) =>
						!isInformational(run.name) && isFailing(run) && !isSuperseded(run, read.superseded),
				)
				.map((run) => run.name)
				.sort();
			const replaced = supersededGating(read)
				.map((run) => run.name)
				.sort();
			const scope = [
				...diagnostics,
				scannedLine(
					VERB,
					read.runs.length,
					"check run",
					`${read.runCount} workflow runs at this head`,
				),
				...(wedged.length === 0
					? []
					: [
							`${VERB}: stranded past the dwell: ${wedged.join(", ")} — the cancel-and-rerun lever is an operator's (#3999).`,
						]),
				...(replaced.length === 0
					? []
					: [
							`${VERB}: cancelled by a newer run of the same workflow at this head: ${replaced.join(", ")} — waiting on that run, not routing.`,
						]),
				...(failing.length === 0
					? []
					: [`${VERB}: failing gating checks: ${failing.join(", ")} — route these to heal-ci.`]),
				...notes,
			];
			const checks = reasonHistogram(read.runs, (run) => checkClassOf(run, read.superseded));
			if (json) {
				return answer(
					JSON.stringify({
						outcome: "checks",
						sha: bound,
						rollup,
						checks,
						workflows: read.workflows.length,
						runs: read.runCount,
						settle,
					}),
					scope,
				);
			}
			return answer(
				[
					...(settle === null ? [] : [`settle\t${settle}`]),
					`checks\t${bound}\t${rollup}`,
					`run\t${read.runs.length}`,
					...Object.entries(checks).map(([checkClass, count]) => `check\t${checkClass}\t${count}`),
					`facts\tworkflows:${read.workflows.length}\truns:${read.runCount}`,
				].join("\n"),
				scope,
			);
		};

		const ci = yield* resolveCi(options.cwd);

		/**
		 * A `green` that no gate of this repo's own produced — the merge-authority fail-open of #6915.
		 *
		 * The same read `review ci` refuses on, through the same module (`../review/gate-coverage.ts`),
		 * asked at the one word that reads as "merge this": a `red` already routes to `heal-ci`, and a
		 * `pending` head is one `ship` waits on rather than lands.
		 */
		const covered = (
			read: Sample,
			rollup: ChecksRollup,
		):
			| {readonly _tag: "Ungated"; readonly outcome: VerbOutcome}
			| {readonly _tag: "Judged"; readonly notes: ReadonlyArray<string>} => {
			if (rollup !== "green") return {_tag: "Judged", notes: []};
			const coverage = gateCoverageOf(read.workflows, read.ranAtHead);
			if (coverage._tag === "Uncovered") {
				return {
					_tag: "Ungated",
					outcome: refuse(
						NO_GATE_COVERAGE,
						`${VERB}: none of the ${coverage.declared} workflow(s) ${repo} authors produced a run at ${bound} — the ${read.runs.length} check run(s) here came from elsewhere, so no gate inspected the bytes this merge would land: green is UNKNOWN, never merged (#6915).`,
						diagnostics,
					),
				};
			}
			return {
				_tag: "Judged",
				notes: [
					coverage._tag === "NoGates"
						? `${VERB}: ${repo} authors no workflow of its own — every run at ${bound} is platform-provided, so there is no gate coverage to judge.`
						: `${VERB}: ${coverage.covered} of ${coverage.declared} workflow(s) ${repo} authors produced a run at ${bound}.`,
				],
			};
		};

		/**
		 * `render`, behind the two doors every exit of this verb passes: gate coverage, and the repo's
		 * own declaration on the no-producer case.
		 *
		 * The rollup already knows a repo has no workflows; what a *caller* gets for that is the
		 * repo's call, and only here is it read — so every exit of this verb, waiting or not, passes
		 * the same door.
		 */
		const settled = (
			read: Sample,
			rollup: ChecksRollup,
			wedged: ReadonlyArray<string>,
			settle: Settle | null,
		): VerbOutcome => {
			const coverage = covered(read, rollup);
			if (coverage._tag === "Ungated") return coverage.outcome;
			if (rollup !== "no-producer") return render(read, rollup, wedged, settle, coverage.notes);
			const producer = producerFor(VERB, repo, read.workflows.length, ci);
			if (producer._tag === "Unknown") return refuse(PRECONDITION_UNKNOWN, producer.reason);
			if (producer._tag === "Refused") return refuse(ZERO_SCOPE, producer.reason, diagnostics);
			const rendered = render(read, rollup, wedged, settle);
			return producer._tag === "OptedOut"
				? {...rendered, stderr: [...rendered.stderr, producer.note]}
				: rendered;
		};

		const first = yield* sample;
		if ("code" in first) return first;
		if (!options.wait) return settled(first, rollupFor(first, []), [], null);

		// The budget is WALL CLOCK, call latency included — v1 counted only its sleeps and silently
		// overran the budget it claimed to hold.
		const startedAt = yield* Clock.currentTimeMillis;
		const stalledSince = new Map<string, number>();
		let read = first;
		for (;;) {
			const now = yield* Clock.currentTimeMillis;
			for (const run of read.runs) {
				if (isStalled(run)) {
					if (!stalledSince.has(run.name)) stalledSince.set(run.name, now);
				} else stalledSince.delete(run.name);
			}
			const wedged = [...stalledSince.entries()]
				.filter(([, since]) => now - since >= options.wedgeDwellSeconds * 1000)
				.map(([name]) => name);
			const rollup = rollupFor(read, wedged);
			if (rollup !== "pending") return settled(read, rollup, wedged, "settled");
			if (now - startedAt >= options.budgetSeconds * 1000) {
				return settled(read, rollup, wedged, "budget-exhausted");
			}
			yield* Effect.sleep(`${options.cadenceSeconds} seconds`);

			const moved = yield* resolvePull(VERB, repo, pr, {
				unknownMessage: (reason) => unreadable("the pull request", reason),
			});
			if (moved._tag === "Refused") return moved.outcome;
			if (!prefixMatch(moved.pull.headSha, bound)) {
				// The answer is about a tree the PR no longer is (#1928's secondary).
				return settled(read, rollupFor(read, wedged), wedged, "head-moved");
			}
			const next = yield* sample;
			if ("code" in next) return next;
			read = next;
		}
	});
