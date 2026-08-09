/**
 * `review deviations` — the PR body's `## Deviations` state, its entries, and the Tier-M token scan
 * over the head diff.
 *
 * The verb reports states and facts, never the §DEV verdict row: whether the PR *owes* the section,
 * and whether an entry's substance covers a finding, are Tier R — the judgment layer's. What this
 * makes mechanical is the one thing a grep can hold an author to: a `None.` printed beside a
 * non-empty Tier-M list is a falsified disclosure the caller sees in one read.
 *
 * The scan inherits `review diff`'s completeness proof, so a truncated diff reds here too — an
 * under-reported hit list beside a `None.` reads as a checked-clean disclosure that was never
 * checked.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getPullDiff} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {readDeviations} from "./deviations.ts";
import {filesInDiff, tierMHits} from "./diff.ts";
import {NULL_TOKEN} from "./scope-verb.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review deviations";

export interface DeviationsOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const unreadable = (pr: number, reason: string): string =>
	`${VERB}: cannot read #${pr}'s body or diff: ${reason} — the disclosure state is UNKNOWN, never "none".`;

export const runDeviations = (
	options: DeviationsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: false,
			requireFiles: false,
			unknownMessage: (reason) => unreadable(pr, reason),
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const served = yield* getPullDiff(repo, pr);
		if (served._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable(pr, served.reason));
		}
		const diff = served.value;
		const seen = filesInDiff(diff);
		const diagnostics = [scannedLine(VERB, seen, "file", `${pull.changedFiles} declared`)];
		if (seen < pull.changedFiles) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the diff for #${pr} is truncated (${seen} of ${pull.changedFiles} files) — refusing a partial Tier-M scan beside a disclosure claim.`,
				diagnostics,
			);
		}

		const section = readDeviations(pull.body);
		const hits = tierMHits(diff);
		return json
			? answer(
					JSON.stringify({
						outcome: section.state,
						entries: section.entries.map((entry) => ({label: entry.label, said: entry.said})),
						tierM: hits,
					}),
					diagnostics,
				)
			: answer(
					[
						`deviations\t${section.state}`,
						...section.entries.map((entry) => `entry\t${entry.label ?? NULL_TOKEN}\t${entry.said}`),
						...hits.map((hit) => `tier-m\t${hit.kind}\t${hit.file}:${hit.line}\t${hit.token}`),
					].join("\n"),
					diagnostics,
				);
	});
