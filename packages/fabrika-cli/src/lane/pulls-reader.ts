/**
 * "Which PR is this issue's", shaped for a sweep: a repo resolved once, then one trace per number.
 *
 * `../build/claimants-verb.ts`'s `claimReader` shape, for its reason — a sweep of forty lanes
 * otherwise pays forty repo resolutions for one answer that cannot change mid-run.
 *
 * **It lives in its own module rather than beside the nominator, and that is load-bearing.** Reading
 * a trace means calling `./nominate.ts`'s reader and `./prove.ts`'s pure `tracePulls`, and putting
 * that pairing inside `nominate.ts` adds a `nominate → prove` value edge. `./prove-verb.ts` already
 * imports the nominator, so that edge closes a cycle through the module graph and one of `prove.ts`'s
 * own exported constants evaluates as `undefined` under the resulting init order — a `review:ui`
 * `PASS` stopped proving and four `lane report` tests went red, with nothing in either file's
 * behaviour changed. A module that imports both and is imported by neither adds no such edge.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {nominatePulls} from "./nominate.ts";
import type {PullTrace} from "./prove.ts";
import {tracePulls} from "./prove.ts";

/** One issue's open pull requests as a trace, or why the board did not answer. */
export type PullsTrace =
	| {readonly _tag: "Read"; readonly trace: PullTrace; readonly scanned: number}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * A memoized reader over one repo.
 *
 * It answers with the **trace** rather than the candidates, so a caller cannot re-derive "which PR
 * is this issue's" out of raw facts and come to mean something `lane prove` does not. `Unknown`
 * carries the nominator's own subject beside its reason, because a read that did not answer is never
 * an empty candidate set.
 */
export const pullsReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): ((
	issue: number,
) => Effect.Effect<PullsTrace, never, ChildProcessSpawner.ChildProcessSpawner>) => {
	let resolved: string | null = null;
	return (issue) =>
		Effect.gen(function* () {
			if (resolved === null) {
				const attempt = yield* resolveRepo(repo, env);
				if (attempt._tag === "Failure") {
					return {
						_tag: "Unknown" as const,
						reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
					};
				}
				resolved = attempt.value;
			}
			const nominated = yield* nominatePulls(resolved, issue);
			if (nominated._tag === "Unreadable") {
				return {_tag: "Unknown" as const, reason: `${nominated.what}: ${nominated.reason}`};
			}
			return {
				_tag: "Read" as const,
				trace: tracePulls(issue, nominated.pulls),
				scanned: nominated.pulls.length,
			};
		});
};
