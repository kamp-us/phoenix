/**
 * The board read [`shape.ts`](shape.ts)'s judgement needs: is this issue an epic, how many sub-issue
 * links does it carry, and does it hang under a parent?
 *
 * The parent edge rides the `getIssue` call already made — `IssueRecord.parent` is populated from
 * the single read's own payload — so the third fact costs no further request (#7381). Epic wins the
 * precedence: a sub-epic routes to `lane emit` like any other epic, and its parenthood changes
 * nothing about which machine it needs.
 *
 * Two reads rather than one, because an epic's two halves of life answer differently and the window
 * between them is #7024's whole incident. A planned epic carries children. An epic nobody has
 * planned yet carries none, and the only thing on the board saying what it is, is its `type:epic`
 * label — so keying on children alone reads a pre-plan epic as an ordinary issue, which is exactly
 * the lane that came up on the single-task coder template at 16:30 before `plan-epic` ever ran.
 *
 * A reader a caller passes rather than a seam a verb reaches through on its own, which is what keeps
 * `lane open` and `lane migrate` provably offline everywhere they are handed `null` — the shape
 * `lane stale`'s claim pairing established (#6771).
 *
 * An unreadable answer is `Unknown`, never `Single`. Reading a failed read as "not an epic" is how a
 * wrong-machine boot would slip through the very refusal this exists to make.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue, resolveRepo} from "../io/issues.ts";
import {listSubIssues} from "../plan/github.ts";
import {EPIC_TYPE_LABEL} from "../triage/facets.ts";
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
			const record = yield* getIssue(resolved, issue);
			if (record._tag !== "Present") {
				return {
					_tag: "Unknown" as const,
					reason:
						record._tag === "Absent"
							? `#${issue} is not present on ${resolved}`
							: `cannot read #${issue}: ${record.reason}`,
				};
			}
			const listed = yield* listSubIssues(resolved, issue, env);
			if (listed._tag === "Failure") {
				return {
					_tag: "Unknown" as const,
					reason: `cannot read #${issue}'s children: ${listed.reason}`,
				};
			}
			const typed = record.value.labels.includes(EPIC_TYPE_LABEL);
			if (typed || listed.value.length > 0) {
				return {
					_tag: "Read" as const,
					expectation: {_tag: "Epic", children: listed.value.length} as const,
				};
			}
			const {parent} = record.value;
			return {
				_tag: "Read" as const,
				expectation:
					parent._tag === "None"
						? ({_tag: "Single"} as const)
						: ({
								_tag: "Child",
								parent: parent._tag === "Parent" ? parent.number : null,
							} as const),
			};
		});
};
