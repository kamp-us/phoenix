/**
 * `review diff` — the PR's diff bytes, read out of one commit, with a short read refused rather than
 * silently passed through.
 *
 * This verb is not a relay, and two proofs are why. **Completeness:** a diff carrying fewer files
 * than the PR declares is refused, because a gate that judged the visible prefix as the whole PR is
 * the #3925 blind-PASS class one layer down; v1's `pr-diff.sh` was the relay, and nothing checked
 * what it served. This is not a guard against a truncating platform: the diff media type refuses an
 * over-limit diff rather than serving a short one, and these bytes never come from it — see
 * `diff.ts` for what the proof does and does not cover (#4993). **Provenance:** the bytes come from
 * the object database at the bound commit via `diffRange`, never from an endpoint that takes a PR
 * number and no commit — see `head.ts` for why a SHA on the verdict is not the same thing as bytes
 * from that SHA (#5117).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {diffRange} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {filesInDiff} from "./diff.ts";
import {bindHead, boundLine} from "./head.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review diff";

export interface DiffOptions {
	readonly pr: number;
	/** The head the caller scoped. `null` binds to the PR's live head instead of asserting one. */
	readonly sha: string | null;
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

		const bound = yield* bindHead(VERB, repo, pr, pull, options.sha);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;

		const served = yield* diffRange(head.base, head.sha);
		if (served._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the diff for #${pr} at ${head.sha}: ${served.reason} — UNKNOWN.`,
			);
		}
		const diff = served.value;
		const seen = filesInDiff(diff);
		const diagnostics = [
			boundLine(VERB, head),
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
				`${VERB}: the diff at ${head.sha} carries ${seen} of #${pr}'s ${pull.changedFiles} declared files — refusing to serve a partial diff as the whole (#3925's class).`,
				diagnostics,
			);
		}
		return answer(diff, diagnostics);
	});
