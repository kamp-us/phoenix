/**
 * The one board read [`shape.ts`](shape.ts)'s judgement needs: does this issue carry sub-issue links?
 *
 * A reader a caller passes rather than a seam a verb reaches through on its own, which is what keeps
 * `lane open` and `lane migrate` provably offline everywhere they are handed `null` — the shape
 * `lane stale`'s claim pairing established (#6771).
 *
 * An unreadable answer is `Unknown`, never `Single`. Reading a failed sub-issue list as "no children"
 * is how a wrong-machine boot would slip through the very refusal this exists to make.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {listSubIssues} from "../plan/github.ts";
import type {Expectation} from "./shape.ts";

export type ExpectationRead =
	| {readonly _tag: "Read"; readonly expectation: Expectation}
	| {readonly _tag: "Unknown"; readonly reason: string};

export type ExpectationReader<R> = (issue: number) => Effect.Effect<ExpectationRead, never, R>;

export const expectationReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): ExpectationReader<ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient> => {
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
			const listed = yield* listSubIssues(resolved, issue, env);
			if (listed._tag === "Failure") {
				return {
					_tag: "Unknown" as const,
					reason: `cannot read #${issue}'s children: ${listed.reason}`,
				};
			}
			return {
				_tag: "Read" as const,
				expectation:
					listed.value.length === 0
						? ({_tag: "Single"} as const)
						: ({_tag: "Epic", children: listed.value.length} as const),
			};
		});
};
