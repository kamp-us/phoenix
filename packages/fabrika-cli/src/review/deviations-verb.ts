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
 * checked. It inherits the same commit binding for the same reason (`head.ts`, #5122): a hit list
 * read from a head nobody scoped is under- or over-reported against the disclosure it is printed
 * beside, and the falsified-`None.` read this verb exists to make possible is only as good as the
 * tree the tokens came from.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {diffRange, diffRangePaths} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {readDeviations} from "./deviations.ts";
import {filesInDiff, tierMHits} from "./diff.ts";
import {bindHead, boundLine} from "./head.ts";
import {NULL_TOKEN} from "./scope-verb.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review deviations";

export interface DeviationsOptions {
	readonly pr: number;
	/** The head the caller scoped. `null` binds to the PR's live head instead of asserting one. */
	readonly sha: string | null;
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

		const bound = yield* bindHead(VERB, repo, pr, pull, options.sha);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;

		const served = yield* diffRange(head.base, head.sha);
		if (served._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable(pr, served.reason));
		}
		const diff = served.value;

		// Both operands of the refusal below come from git over the SAME range under the SAME flags:
		// `--name-only -z` emits one path per `diff --git` entry, so rename pairing and merge-base
		// choice cancel instead of being compared across systems. What that proves is narrow and worth
		// stating plainly — the scanned bytes carry every entry this second read lists. It does not
		// prove the range is the right one, and a fault that shortens both reads alike is invisible to
		// it. GitHub's `changed_files` is a third party's answer over its own base and its own rename
		// detection, so it is reported in the diagnostics and never refused on (#5157).
		const listed = yield* diffRangePaths(head.base, head.sha);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the file list of the range ${head.base}...${head.sha} for #${pr}: ${listed.reason} — the disclosure state is UNKNOWN, never "none".`,
			);
		}
		const inRange = listed.value.length;

		const seen = filesInDiff(diff);
		const diagnostics = [
			boundLine(VERB, head),
			scannedLine(
				VERB,
				seen,
				"file",
				`${inRange} in the range per git, ${pull.changedFiles} declared by GitHub`,
			),
		];
		if (inRange !== pull.changedFiles) {
			diagnostics.push(
				`${VERB}: git and GitHub disagree on #${pr}'s file count (${inRange} vs ${pull.changedFiles}) — different merge base and different rename detection; reported, never refused on (#5157).`,
			);
		}
		if (seen < inRange) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the scan at ${head.sha} covers ${seen} of the ${inRange} files git lists for the same range ${head.base}...${head.sha} — both counts from git, so these bytes are provably short of the range they were read from; refusing a partial Tier-M scan beside a disclosure claim.`,
				diagnostics,
			);
		}

		const section = readDeviations(pull.body);
		if (section.reason !== null) {
			diagnostics.push(`${VERB}: ${section.state} — ${section.reason}.`);
		}
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
