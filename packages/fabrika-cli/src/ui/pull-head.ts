/**
 * The one PR field `ui evidence` needs that `../io/pulls.ts`'s record does not carry: the head
 * branch. An evidence comment on a PR whose head is some *other* lane's branch is a cross-lane
 * write, so the check needs the ref itself, not the head SHA the record already holds.
 *
 * The tracer for the fetch client (ADR 0315): this read goes through `../io/gh-api.ts` rather than
 * `gh api`, so the client is proved by a running verb and not only by its own tests. A shape that is
 * not a branch name is a failure rather than an empty string — an unreadable ref must not compare
 * equal to a detached HEAD.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {existenceOf, resolveToken, restRead} from "../io/gh-api.ts";
import {fail, ok} from "../io/git.ts";
import {isRecord} from "../io/json.ts";

export type HeadRef =
	| {readonly _tag: "Ref"; readonly ref: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

export const pullHeadRef = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	pr: number,
): Effect.Effect<HeadRef, never, HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return {_tag: "Unknown" as const, reason: token.reason};
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/pulls/${pr}`);
		const read = existenceOf(outcome, (body) => {
			const ref = isRecord(body) && isRecord(body.head) ? body.head.ref : undefined;
			return typeof ref === "string" && ref.trim() !== ""
				? ok(ref.trim())
				: fail("GitHub answered 200 but named no head branch");
		});
		if (read._tag === "Present") return {_tag: "Ref" as const, ref: read.value};
		return {
			_tag: "Unknown" as const,
			reason: read._tag === "Absent" ? `PR #${pr} does not exist` : read.reason,
		};
	});
