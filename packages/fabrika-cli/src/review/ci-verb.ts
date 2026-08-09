/**
 * `review ci` — the live check-run rollup at a head, fail-closed on incomplete enumeration.
 *
 * v1's CI-at-head read was dispatch-prompt-dependent: a gate ruled on a live RED check as a prose
 * question because one sentence was omitted (#4552). This verb is that read made structural, and its
 * two refusals are what keep it honest — zero declared runs is a vacuous green (ADR 0092), and an
 * enumeration short of `total_count` is never read as "no red checks" (#3999).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {commitExists, listCheckRuns} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {rollupOf, statusOf} from "./rollup.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review ci";

export interface CiOptions {
	readonly pr: number;
	readonly sha: string | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

export const runCi = (
	options: CiOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
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
		return json
			? answer(
					JSON.stringify({
						outcome: "ci",
						sha,
						rollup,
						checks: runs.map((run) => ({name: run.name, status: statusOf(run)})),
						scanned: runs.length,
						declared,
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
