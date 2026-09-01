/**
 * `review ci` — the live check-run rollup at a head, fail-closed on incomplete enumeration.
 *
 * v1's CI-at-head read was dispatch-prompt-dependent: a gate ruled on a live RED check as a prose
 * question because one sentence was omitted (#4552). This verb is that read made structural, and its
 * refusals are what keep it honest — zero declared runs is a vacuous green (ADR 0092), an
 * enumeration short of `total_count` is never read as "no red checks" (#3999), and a complete
 * enumeration that no gate of this repo produced is not green either (#6522, `gate-coverage.ts`).
 *
 * `checks` is a status tally, not a row per run: it is an evidence-array under ADR 0308 — the review
 * skill acts on `rollup` and no skill iterates the rows — and a repo with 34 workflows paid ~20 rows
 * of it on every read. What the rows were *for*, naming the red and still-running checks, moves to
 * the notes channel below, the same split `ship checks` landed on.
 *
 * `--wait` is the bounded in-verb wait a reviewer spawned minutes after a push needs: a `pending`
 * there is the ordinary state of a healthy PR, and a caller that cannot wait for it has only a park
 * on a human to offer for a condition that clears itself (#7282). The verb owns the loop so no skill
 * ever sleeps — `claude-plugins/fabrika/docs/skill-conventions.md` §14 — and it loops on `pending`
 * alone: every refusal and the `no-producer` answer are states no amount of waiting changes, so they
 * return on the first read rather than burning the budget. The governance floor is such a state on
 * both of its rollups — `governance-owed` on the `pending` one, `governance-stale` on the `red`
 * (`./governance-owed.ts`).
 */
import {Clock, Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {producerFor, resolveCi} from "../config/ci-producer.ts";
import {type ReasonHistogram, reasonHistogram} from "../evidence.ts";
import {FLOOR_WORKFLOW_NAME} from "../governance/floor-assert.ts";
import {type CheckRun, commitExists, listCheckRuns} from "../io/pulls.ts";
// The workflow inventory is read through the `ship` group's reader for the same reason `ship checks`
// rolls up through this group's `rollup.ts`: one read, so the two verbs cannot drift on the fact.
import {CHECK_RUN_NAME} from "../ship/floor-check.ts";
import {listRunsAtHead, listWorkflowPaths, listWorkflows} from "../ship/github.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, NO_GATE_COVERAGE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {gateCoverageOf} from "./gate-coverage.ts";
import {governanceOwed, governanceStale, staleFloorIsTheOnlyRed} from "./governance-owed.ts";
import {isFailing, type Rollup, rollupOf, statusOf} from "./rollup.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review ci";

/**
 * How a `--wait` ended — the token that keeps a waited answer distinguishable from a point read.
 *
 * `budget-exhausted` is the one a caller must not read as a verdict: the rollup beside it is still
 * `pending`, so nothing about the head was proven, and the answer says the wait ran out rather than
 * that CI concluded.
 *
 * `governance-owed` and `governance-stale` are the two the caller can clear itself — see
 * {@link governanceOwed} and {@link governanceStale}. Each is its own word rather than a faster
 * `budget-exhausted` or a plain `settled`, because they route differently from both: a stuck queue
 * is a human's, while a verdict the reader still owes is the reader's (#7392, #7441).
 */
export type Settle =
	| "settled"
	| "budget-exhausted"
	| "head-moved"
	| "governance-owed"
	| "governance-stale";

export interface CiOptions {
	readonly pr: number;
	readonly sha: string | null;
	readonly wait: boolean;
	readonly budgetSeconds: number;
	readonly cadenceSeconds: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Where `.fabrika.jsonc` is looked for — the repo root above it, per `config/working-root.ts`. */
	readonly cwd: string;
}

/** One enumeration at the bound head: an outcome no wait can change, or a rollup to route on. */
type Sample =
	| {readonly _tag: "Done"; readonly outcome: VerbOutcome}
	| {
			readonly _tag: "Read";
			readonly rollup: Rollup;
			readonly runs: ReadonlyArray<CheckRun>;
			readonly declared: number;
			readonly gates: {readonly declared: number; readonly covered: number} | null;
			/** This head's only unfinished check is a floor whose run is done — nothing else can move it. */
			readonly owedGovernance: boolean;
			/** This head's only failing check is a floor whose verdict is stale — the reader's to clear. */
			readonly staleGovernance: boolean;
			readonly notes: ReadonlyArray<string>;
	  };

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * The rollup token for a repo that has opted out of having CI at all.
 *
 * Its own word, deliberately outside {@link rollupOf}'s three: a caller keying on `green` must not
 * see one here, and a caller keying on `pending` must not wait for a run that will never start —
 * which is why `--wait` returns this answer on the first read and carries no settle token, there
 * having been nothing to wait for.
 */
const NO_PRODUCER = "no-producer";

const noProducerAnswer = (
	sha: string,
	json: boolean,
	diagnostics: ReadonlyArray<string>,
): VerbOutcome =>
	json
		? answer(
				JSON.stringify({
					outcome: "ci",
					sha,
					rollup: NO_PRODUCER,
					checks: {},
					scanned: 0,
					declared: 0,
					gates: null,
					settle: null,
				}),
				diagnostics,
			)
		: answer([`ci\t${sha}\t${NO_PRODUCER}`, "run\t0"].join("\n"), diagnostics);

/**
 * The check runs a reader still needs by name, on the notes channel (ADR 0308).
 *
 * The rows the tally replaces existed so "a red or still-running check is in the gate's context by
 * name, not as a rollup boolean" — that sentence is about the red and the in-flight runs, and every
 * other row it also printed was a passing name nobody read. So the names survive, addressed to the
 * channel diagnostics belong on, and the answer channel carries the counts.
 */
export const namedLines = (verb: string, runs: ReadonlyArray<CheckRun>): ReadonlyArray<string> => {
	const failing = runs.filter(isFailing).map((run) => run.name);
	const running = runs.filter((run) => run.status !== "completed").map((run) => run.name);
	return [
		...(failing.length === 0
			? []
			: [`${verb}: failing at this head: ${[...failing].sort().join(", ")}.`]),
		...(running.length === 0
			? []
			: [`${verb}: still running at this head: ${[...running].sort().join(", ")}.`]),
	];
};

export const runCi = (
	options: CiOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {requireOpen: false, requireFiles: false});
		if (target._tag === "Refused") return target.outcome;
		const live = target.pull.headSha;

		const asked = options.sha?.trim() ?? "";
		const diagnostics: string[] = [];
		let sha = live;
		if (asked !== "") {
			const at = yield* commitExists(repo, asked);
			if (at._tag === "Absent") {
				return refuse(ZERO_SCOPE, `${VERB}: no commit ${asked} on PR #${pr} in ${repo}.`);
			}
			if (at._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot enumerate check runs at ${asked}: ${at.reason} — CI state is UNKNOWN, never green.`,
				);
			}
			sha = asked;
			// A read at a moved-past head is a fact worth seeing, not a refusal: the `12` stale seat
			// belongs to `review post`, the write seam.
			if (!prefixMatch(live, asked)) {
				diagnostics.push(
					`${VERB}: the live head is ${live}, you are enumerating at ${asked} — the head moved; a verdict still binds only what was inspected.`,
				);
			}
		}

		const sample: Effect.Effect<
			Sample,
			never,
			ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
		> = Effect.gen(function* () {
			const done = (outcome: VerbOutcome): Sample => ({_tag: "Done", outcome});
			const enumerated = yield* listCheckRuns(repo, sha);
			if (enumerated._tag === "Failure") {
				return done(
					refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot enumerate check runs at ${sha}: ${enumerated.reason} — CI state is UNKNOWN, never green.`,
						diagnostics,
					),
				);
			}
			const {declared, runs} = enumerated.value;
			// Every poll re-reads the head, so the scanned line is this sample's, not the run's: it
			// rides the sample's own notes and never accumulates one row per poll on the preamble.
			const notes = [
				...diagnostics,
				scannedLine(VERB, runs.length, "check run", `${declared} declared`),
			];
			if (declared === 0) {
				// The producer question is asked HERE and nowhere else on this path: an enumeration that
				// returned runs already proves a producer. Empty is the one reading where "no CI at all"
				// and "nothing has reported yet" are two different repos wearing one answer.
				const inventory = yield* listWorkflows(repo);
				if (inventory._tag === "Failure") {
					return done(
						refuse(
							PRECONDITION_UNKNOWN,
							`${VERB}: cannot enumerate the workflow inventory of ${repo}: ${inventory.reason} — whether a producer exists is UNKNOWN, never green.`,
							notes,
						),
					);
				}
				const producer = producerFor(VERB, repo, inventory.value, yield* resolveCi(options.cwd));
				if (producer._tag === "Unknown") {
					return done(refuse(PRECONDITION_UNKNOWN, producer.reason, notes));
				}
				if (producer._tag === "Refused") return done(refuse(ZERO_SCOPE, producer.reason, notes));
				if (producer._tag === "OptedOut") {
					return done(noProducerAnswer(sha, json, [...notes, producer.note]));
				}
				return done(
					refuse(
						ZERO_SCOPE,
						`${VERB}: zero check runs declared at ${sha} — refusing to report green over an empty enumeration (ADR 0092).`,
						notes,
					),
				);
			}
			if (runs.length < declared) {
				return done(
					refuse(
						INCOMPLETE_SCAN,
						`${VERB}: received ${runs.length} of ${declared} declared check runs at ${sha} — refusing the partial enumeration (#3999).`,
						notes,
					),
				);
			}

			const rollup = rollupOf(runs);
			notes.push(...namedLines(VERB, runs));
			// A red rollup is already the answer a caller must act on, so the coverage question is asked
			// only where it changes one: `green` and `pending` are the two words that read as "nothing to
			// do here", and both are wrong over bytes no gate inspected.
			let gates: {readonly declared: number; readonly covered: number} | null = null;
			let owedGovernance = false;
			let staleGovernance = false;
			if (rollup === "red" && staleFloorIsTheOnlyRed(runs)) {
				// The one red that is also asked: a floor concluded `failure` on a stale verdict is the
				// reader's own to clear, and only the workflow runs say the row came from this repo's floor
				// job. The cheap predicate above gates the read, so an ordinary red still pays nothing.
				const atHead = yield* listRunsAtHead(repo, sha);
				if (atHead._tag === "Failure") {
					return done(
						refuse(
							PRECONDITION_UNKNOWN,
							`${VERB}: cannot enumerate the workflow runs at ${sha}: ${atHead.reason} — whether this red is the caller's own floor is UNKNOWN.`,
							notes,
						),
					);
				}
				staleGovernance = governanceStale(runs, atHead.value.runs);
				if (staleGovernance) {
					notes.push(
						`${VERB}: the only failing check at ${sha} is "${CHECK_RUN_NAME}", and the governance verdict behind it is bound to another head (ADR 0318). This red is yours to clear: fire the governance skill, then re-read.`,
					);
				}
			}
			if (rollup !== "red") {
				const inventory = yield* listWorkflowPaths(repo);
				if (inventory._tag === "Failure") {
					return done(
						refuse(
							PRECONDITION_UNKNOWN,
							`${VERB}: cannot enumerate the workflow inventory of ${repo}: ${inventory.reason} — which gates exist is UNKNOWN, never green.`,
							notes,
						),
					);
				}
				const atHead = yield* listRunsAtHead(repo, sha);
				if (atHead._tag === "Failure") {
					return done(
						refuse(
							PRECONDITION_UNKNOWN,
							`${VERB}: cannot enumerate the workflow runs at ${sha}: ${atHead.reason} — which gates ran is UNKNOWN, never green.`,
							notes,
						),
					);
				}
				const coverage = gateCoverageOf(
					inventory.value,
					atHead.value.runs.map((run) => run.path),
				);
				if (coverage._tag === "Uncovered") {
					// The `16` refusal is why `--wait` may not simply loop on "not green": a head no gate of
					// this repo ran at has nothing coming, so waiting out the budget would answer nothing.
					return done(
						refuse(
							NO_GATE_COVERAGE,
							`${VERB}: none of the ${coverage.declared} workflow(s) ${repo} authors produced a run at ${sha} — the ${runs.length} check run(s) here came from elsewhere, so no gate inspected these bytes: the CI state is UNKNOWN, never green (#6522).`,
							notes,
						),
					);
				}
				if (coverage._tag === "NoGates") {
					notes.push(
						`${VERB}: ${repo} authors no workflow of its own — every run at ${sha} is platform-provided, so there is no gate coverage to judge.`,
					);
				} else {
					gates = {declared: coverage.declared, covered: coverage.covered};
					notes.push(
						`${VERB}: ${coverage.covered} of ${coverage.declared} workflow(s) ${repo} authors produced a run at ${sha}.`,
					);
				}
				owedGovernance = governanceOwed(runs, atHead.value.runs);
				if (owedGovernance) {
					notes.push(
						`${VERB}: the only unfinished check at ${sha} is "${CHECK_RUN_NAME}", and its ${FLOOR_WORKFLOW_NAME} run has completed — what is still owed is a governance verdict bound at this head (ADR 0318), which no wait produces. Fire the governance skill, then re-read.`,
					);
				}
			}
			return {
				_tag: "Read",
				rollup,
				runs,
				declared,
				gates,
				owedGovernance,
				staleGovernance,
				notes,
			} satisfies Sample;
		});

		const render = (read: Extract<Sample, {_tag: "Read"}>, settle: Settle | null): VerbOutcome => {
			const checks: ReasonHistogram = reasonHistogram(read.runs, statusOf);
			return json
				? answer(
						JSON.stringify({
							outcome: "ci",
							sha,
							rollup: read.rollup,
							checks,
							scanned: read.runs.length,
							declared: read.declared,
							gates: read.gates,
							settle,
						}),
						read.notes,
					)
				: answer(
						[
							...(settle === null ? [] : [`settle\t${settle}`]),
							`ci\t${sha}\t${read.rollup}`,
							`run\t${read.runs.length}`,
							...Object.entries(checks).map(([status, count]) => `check\t${status}\t${count}`),
						].join("\n"),
						read.notes,
					);
		};

		const first = yield* sample;
		if (first._tag === "Done") return first.outcome;
		if (!options.wait) return render(first, null);

		// The budget is WALL CLOCK, gh-call latency included — counting only the sleeps is how a verb
		// silently overruns the bound it claims to hold (`ship checks --wait` records the same lesson).
		const startedAt = yield* Clock.currentTimeMillis;
		let read = first;
		for (;;) {
			if (read.rollup !== "pending") {
				return render(read, read.staleGovernance ? "governance-stale" : "settled");
			}
			// Checked before the budget, on every poll including the first: the caller owes this one
			// itself, so a sleep here spends the whole horizon on a check nothing external can move.
			if (read.owedGovernance) return render(read, "governance-owed");
			const now = yield* Clock.currentTimeMillis;
			if (now - startedAt >= options.budgetSeconds * 1000) {
				return render(read, "budget-exhausted");
			}
			yield* Effect.sleep(`${options.cadenceSeconds} seconds`);

			const moved = yield* openPull(VERB, repo, pr, {requireOpen: false, requireFiles: false});
			if (moved._tag === "Refused") return moved.outcome;
			if (!prefixMatch(moved.pull.headSha, sha)) {
				// The wait was for a tree the PR no longer is: the last read still binds what it inspected,
				// and the caller is told the head moved rather than handed a stale `settled`.
				return render(read, "head-moved");
			}
			const next = yield* sample;
			if (next._tag === "Done") return next.outcome;
			read = next;
		}
	});
