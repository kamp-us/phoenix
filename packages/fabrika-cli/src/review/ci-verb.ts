/**
 * `review ci` — the live check-run rollup at a head, fail-closed on incomplete enumeration.
 *
 * v1's CI-at-head read was dispatch-prompt-dependent: a gate ruled on a live RED check as a prose
 * question because one sentence was omitted (#4552). This verb is that read made structural, and its
 * refusals are what keep it honest — zero declared runs is a vacuous green (ADR 0092), an
 * enumeration short of `total_count` is never read as "no red checks" (#3999), and a complete
 * enumeration that no gate of this repo produced is not green either (#6522, `gate-coverage.ts`).
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {producerFor, resolveCi} from "../config/ci-producer.ts";
import {commitExists, listCheckRuns} from "../io/pulls.ts";
// The workflow inventory is read through the `ship` group's reader for the same reason `ship checks`
// rolls up through this group's `rollup.ts`: one read, so the two verbs cannot drift on the fact.
import {listRunsAtHead, listWorkflowPaths, listWorkflows} from "../ship/github.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, NO_GATE_COVERAGE, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {gateCoverageOf} from "./gate-coverage.ts";
import {rollupOf, statusOf} from "./rollup.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review ci";

export interface CiOptions {
	readonly pr: number;
	readonly sha: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Where `.fabrika.jsonc` is looked for — the repo root above it, per `config/working-root.ts`. */
	readonly cwd: string;
}

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * The rollup token for a repo that has opted out of having CI at all.
 *
 * Its own word, deliberately outside {@link rollupOf}'s three: a caller keying on `green` must not
 * see one here, and a caller keying on `pending` must not wait for a run that will never start.
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
					checks: [],
					scanned: 0,
					declared: 0,
					gates: null,
				}),
				diagnostics,
			)
		: answer([`ci\t${sha}\t${NO_PRODUCER}`, "check\t0"].join("\n"), diagnostics);

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

		const enumerated = yield* listCheckRuns(repo, sha);
		if (enumerated._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot enumerate check runs at ${sha}: ${enumerated.reason} — CI state is UNKNOWN, never green.`,
				diagnostics,
			);
		}
		const {declared, runs} = enumerated.value;
		diagnostics.push(scannedLine(VERB, runs.length, "check run", `${declared} declared`));
		if (declared === 0) {
			// The producer question is asked HERE and nowhere else on this path: an enumeration that
			// returned runs already proves a producer. Empty is the one reading where "no CI at all"
			// and "nothing has reported yet" are two different repos wearing one answer.
			const inventory = yield* listWorkflows(repo);
			if (inventory._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot enumerate the workflow inventory of ${repo}: ${inventory.reason} — whether a producer exists is UNKNOWN, never green.`,
					diagnostics,
				);
			}
			const producer = producerFor(VERB, repo, inventory.value, yield* resolveCi(options.cwd));
			if (producer._tag === "Unknown") {
				return refuse(PRECONDITION_UNKNOWN, producer.reason, diagnostics);
			}
			if (producer._tag === "Refused") return refuse(ZERO_SCOPE, producer.reason, diagnostics);
			if (producer._tag === "OptedOut") {
				return noProducerAnswer(sha, json, [...diagnostics, producer.note]);
			}
			return refuse(
				ZERO_SCOPE,
				`${VERB}: zero check runs declared at ${sha} — refusing to report green over an empty enumeration (ADR 0092).`,
				diagnostics,
			);
		}
		if (runs.length < declared) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${runs.length} of ${declared} declared check runs at ${sha} — refusing the partial enumeration (#3999).`,
				diagnostics,
			);
		}

		const rollup = rollupOf(runs);
		// A red rollup is already the answer a caller must act on, so the coverage question is asked
		// only where it changes one: `green` and `pending` are the two words that read as "nothing to
		// do here", and both are wrong over bytes no gate inspected.
		let gates: {readonly declared: number; readonly covered: number} | null = null;
		if (rollup !== "red") {
			const inventory = yield* listWorkflowPaths(repo);
			if (inventory._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot enumerate the workflow inventory of ${repo}: ${inventory.reason} — which gates exist is UNKNOWN, never green.`,
					diagnostics,
				);
			}
			const atHead = yield* listRunsAtHead(repo, sha);
			if (atHead._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot enumerate the workflow runs at ${sha}: ${atHead.reason} — which gates ran is UNKNOWN, never green.`,
					diagnostics,
				);
			}
			const coverage = gateCoverageOf(
				inventory.value,
				atHead.value.runs.map((run) => run.path),
			);
			if (coverage._tag === "Uncovered") {
				return refuse(
					NO_GATE_COVERAGE,
					`${VERB}: none of the ${coverage.declared} workflow(s) ${repo} authors produced a run at ${sha} — the ${runs.length} check run(s) here came from elsewhere, so no gate inspected these bytes: the CI state is UNKNOWN, never green (#6522).`,
					diagnostics,
				);
			}
			if (coverage._tag === "NoGates") {
				diagnostics.push(
					`${VERB}: ${repo} authors no workflow of its own — every run at ${sha} is platform-provided, so there is no gate coverage to judge.`,
				);
			} else {
				gates = {declared: coverage.declared, covered: coverage.covered};
				diagnostics.push(
					`${VERB}: ${coverage.covered} of ${coverage.declared} workflow(s) ${repo} authors produced a run at ${sha}.`,
				);
			}
		}
		return json
			? answer(
					JSON.stringify({
						outcome: "ci",
						sha,
						rollup,
						checks: runs.map((run) => ({name: run.name, status: statusOf(run)})),
						scanned: runs.length,
						declared,
						gates,
					}),
					diagnostics,
				)
			: answer(
					[
						`ci\t${sha}\t${rollup}`,
						`check\t${runs.length}`,
						...runs.map((run) => `${run.name}\t${statusOf(run)}`),
					].join("\n"),
					diagnostics,
				);
	});
