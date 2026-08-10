/**
 * The one PR field `ui evidence` needs that `../io/pulls.ts`'s record does not carry: the head
 * branch. An evidence comment on a PR whose head is some *other* lane's branch is a cross-lane
 * write, so the check needs the ref itself, not the head SHA the record already holds.
 *
 * Read through `gh api` REST like every other GitHub access here (skill conventions §11), and a shape
 * that is not a branch name is a failure rather than an empty string — an unreadable ref must not
 * compare equal to a detached HEAD.
 */
import {Effect} from "effect";
import {execCapture} from "../io/exec.ts";
import type {Shell} from "../io/git.ts";

export type HeadRef =
	| {readonly _tag: "Ref"; readonly ref: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

export const pullHeadRef = (repo: string, pr: number): Shell<HeadRef> =>
	Effect.gen(function* () {
		const r = yield* execCapture("gh", ["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.ref"]);
		if (!r.ok) return {_tag: "Unknown" as const, reason: r.reason};
		const ref = r.stdout.trim();
		return ref === ""
			? {_tag: "Unknown" as const, reason: "`gh api` exited 0 but named no head branch"}
			: {_tag: "Ref" as const, ref};
	});
