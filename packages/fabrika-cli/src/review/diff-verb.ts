/**
 * `review diff` — the PR's diff bytes, with truncation refused rather than silently passed through.
 *
 * This verb is not a relay, and the completeness proof is why: GitHub truncates large diffs at the
 * API tier, so a gate that judged the visible prefix as the whole PR is the #3925 blind-PASS class
 * one layer down. v1's `pr-diff.sh` was the relay, and nothing checked what it served.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getPullDiff} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {filesInDiff} from "./diff.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review diff";

export interface DiffOptions {
	readonly pr: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runDiff = (
	options: DiffOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			requireFiles: true,
			emptyReason: "refusing to serve an empty diff as a reviewable one (ADR 0092).",
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const served = yield* getPullDiff(repo, pr);
		if (served._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the diff for #${pr}: ${served.reason} — UNKNOWN.`,
			);
		}
		const diff = served.value;
		const seen = filesInDiff(diff);
		const diagnostics = [
			scannedLine(
				VERB,
				seen,
				"file",
				`${pull.changedFiles} declared, ${new TextEncoder().encode(diff).length} bytes`,
			),
		];
		if (seen < pull.changedFiles) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the diff for #${pr} is truncated (${seen} of ${pull.changedFiles} files) — refusing to serve a partial diff as the whole (#3925's class).`,
				diagnostics,
			);
		}
		return answer(diff, diagnostics);
	});
