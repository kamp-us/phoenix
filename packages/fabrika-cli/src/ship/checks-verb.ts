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
 */
import {Clock, Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {producerFor, resolveCi} from "../config/ci-producer.ts";
import {reasonHistogram} from "../evidence.ts";
import {commitExists} from "../io/pulls.ts";
import {isFailing, isInformational, isStalled, rollupOf, statusOf} from "../review/rollup.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	latestPerContext,
	listRunsAtHead,
	listShipCheckRuns,
	listWorkflows,
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
	readonly workflows: number;
	readonly runCount: number;
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
		if (sample.workflows === 0) return "no-producer";
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
			const workflows = yield* listWorkflows(repo);
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
				superseded: supersededSuites(atHead.value.runs),
			} satisfies Sample;
		});

		const render = (
			read: Sample,
			rollup: ChecksRollup,
			wedged: ReadonlyArray<string>,
			settle: Settle | null,
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
			];
			const checks = reasonHistogram(read.runs, (run) => checkClassOf(run, read.superseded));
			if (json) {
				return answer(
					JSON.stringify({
						outcome: "checks",
						sha: bound,
						rollup,
						checks,
						workflows: read.workflows,
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
					`facts\tworkflows:${read.workflows}\truns:${read.runCount}`,
				].join("\n"),
				scope,
			);
		};

		const ci = yield* resolveCi(options.cwd);

		/**
		 * `render`, with the no-producer case routed through the repo's own declaration first.
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
			if (rollup !== "no-producer") return render(read, rollup, wedged, settle);
			const producer = producerFor(VERB, repo, read.workflows, ci);
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
