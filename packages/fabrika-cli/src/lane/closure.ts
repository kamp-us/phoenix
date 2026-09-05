/**
 * What the merge behind a ship-stage terminal closed — the one board read `lane prove` and
 * `lane reconcile` share, so the two verbs cannot disagree about one merge (#7457).
 *
 * **It reads the PR the line names, and nominates nothing.** That is not a shortcut past the
 * group's one nominator but a different question: a nominator answers "which PR is this issue's",
 * and the shipper recording the terminal already answered it — `lane report --pr` carries the URL
 * onto the very line being written, and a recorded line keeps it for `lane reconcile` to re-read.
 * Nominating here would also answer wrongly, which is the whole of #7457: a MERGED `Part of #N` is
 * invisible to both nomination reads, the closing edge being built from closing keywords and the
 * search half being `is:open`, so the union finds nothing for exactly the case ADR 0343 exists to
 * catch. `nominatePulls` is unchanged — #6717's argument against widening it still stands.
 *
 * A line naming no PR falls back to the nominator at `open-or-merged`, which is the best answer
 * available without evidence on the line. Either way the judgement is {@link provenClosure}'s, not
 * `traceClosure`'s directly: a read that failed and a read that proved nothing are both `Unknown`
 * and never `Closes`, since reading either as a closing merge is the permissive fold ADR 0343 and
 * #7433 exist to undo.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import {issueRefsOf} from "../review/classes.ts";
import {nominatePulls} from "./nominate.ts";
import {type ClosureRead, provenClosure, pullNumberIn} from "./reconcile.ts";

export type ClosureReader<R> = (
	issue: number,
	pr: string | null,
) => Effect.Effect<ClosureRead, never, R>;

export const closureReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): ClosureReader<ChildProcessSpawner.ChildProcessSpawner> => {
	let resolved: string | null = null;
	return (issue, pr) =>
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
			const number = pullNumberIn(pr);
			if (number === null) {
				const nominated = yield* nominatePulls(resolved, issue, "open-or-merged");
				return nominated._tag === "Unreadable"
					? {_tag: "Unknown" as const, reason: `cannot read ${nominated.what}: ${nominated.reason}`}
					: provenClosure(issue, nominated.pulls);
			}
			const pull = yield* getPullRequest(resolved, number);
			if (pull._tag === "Unknown") {
				return {_tag: "Unknown" as const, reason: `cannot read PR #${number}: ${pull.reason}`};
			}
			if (pull._tag === "Absent") {
				return {
					_tag: "Unknown" as const,
					reason: `the line names PR #${number}, which is not there`,
				};
			}
			const refs = issueRefsOf(pull.value.body);
			return provenClosure(issue, [
				{
					number: pull.value.number,
					open: pull.value.state === "open",
					merged: pull.value.merged,
					linkedIssues: refs.numbers,
					linkKind: refs.kind,
				},
			]);
		});
};
