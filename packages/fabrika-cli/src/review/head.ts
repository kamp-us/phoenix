/**
 * The step every read verb runs before it reads anything: tie the artifact it is about to serve to
 * one commit, or refuse.
 *
 * **A SHA on a verdict is a label; bytes provably read out of that commit are the immunity.** The
 * platform's PR endpoints take a pull-request number and no commit at all, so a push landing between
 * scoping and reading serves the *new* head's bytes under the *old* head's SHA — a well-formed,
 * confident verdict over code nobody judged (#5117, the #4482 class one layer down). The post-time
 * re-resolve cannot close it: it fires after the judging, and a rewind that lands back on the
 * recorded SHA passes it clean.
 *
 * **This is the READ binding, and it is not what a verdict survives on.** The distinction is easy to
 * lose and ADR 0276 turns on it: what is resolved here is which commit this run's bytes come out of,
 * which is unchanged. Whether a verdict formed over those bytes is still in force *after the head
 * moves* is a separate question, answered by the content digest taken over this same range
 * (`./content-binding.ts`) — a head move alone no longer settles it.
 *
 * The binding is therefore taken **here, before the read**, and every read downstream of it goes
 * through the object database at the resolved commit (`../io/git.ts`). Nothing is checked out —
 * `contract.md`'s "Considered and deliberately not derived" rules out a head worktree, and that
 * decision stands: a head that is never checked out is a head whose instructions are never loaded.
 * A fetch writes objects, not a working tree, so the two properties are not in tension.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {fetchAndResolve, fetchRef, mergeBase, remoteFor, resolveCommit} from "../io/git.ts";
import type {PullRecord} from "../io/pulls.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {headSha} from "../wire/verdict-marker.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, STALE_HEAD} from "./codes.ts";

/**
 * The commits every bound read is taken between, each a full object name git itself resolved.
 *
 * **`baseTip` and `mergeBase` are different commits, and the difference is not intermittent.** Under
 * a moving base branch `origin/<baseRef>` runs ahead of the point this branch diverged from, so a
 * value read as "the base" while it holds the branch tip is wrong by construction (#5770). They are
 * two fields rather than one so that no caller can take the wrong one silently: a range, a point
 * read and a printed base all mean the merge base, and the tip is only what derives it.
 */
export interface BoundHead {
	readonly sha: string;
	/** Where the base branch is *now* — `origin/<baseRef>` at fetch time, ahead of the branch point. */
	readonly baseTip: string;
	/** Where this branch left the base branch. The commit every reader downstream means by "base". */
	readonly mergeBase: string;
}

export type Binding =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Bound"; readonly head: BoundHead};

const unknown = (verb: string, what: string): Binding => ({
	_tag: "Refused",
	outcome: refuse(
		PRECONDITION_UNKNOWN,
		`${verb}: ${what} — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.`,
	),
});

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * Bind this run's read to one commit: the `--sha` the caller scoped, or the PR's live head.
 *
 * Four things have to hold, and each is checked against evidence from a different origin — a check
 * whose two operands come from the same read proves only that the read is self-consistent, which is
 * exactly what an unbound read already is.
 *
 * 1. An explicit `--sha` must be **the PR's head**. A caller reading at a head the PR has moved past
 *    is judging a tree the platform no longer offers, and `review post` would refuse the verdict
 *    anyway — refusing here means it refuses *before* a human spends a review on it (ADR 0058).
 * 2. This checkout must serve the target repository, or nothing local can witness the commit.
 * 3. The commit must be **present in the object database after fetching `pull/<pr>/head`**, and
 *    `git rev-parse` must resolve it to itself. That second half is not ceremony: a local ref or tag
 *    spelled as hex resolves to a different object, which is how a "verified" name still names the
 *    wrong tree.
 * 4. The base must resolve too, since a diff is a range and an unresolvable end makes it UNKNOWN —
 *    and so must the merge base of that tip and this head, because *that* is the end every caller
 *    downstream means by "base" (#5770).
 */
export const bindHead = (
	verb: string,
	repo: string,
	pr: number,
	pull: PullRecord,
	asked: string | null,
): Effect.Effect<Binding, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		let wanted = pull.headSha;
		if (asked !== null) {
			const shaped = headSha(asked);
			if (shaped === null) {
				return {
					_tag: "Refused" as const,
					outcome: refuse(
						OFF_VOCABULARY,
						`${verb}: --sha "${asked}" is not a head SHA — expected 7–40 hex characters.`,
					),
				};
			}
			if (!prefixMatch(pull.headSha, shaped)) {
				return {
					_tag: "Refused" as const,
					outcome: refuse(
						STALE_HEAD,
						`${verb}: PR #${pr}'s head is ${pull.headSha}, not ${shaped} — the tree you scoped is not the one under review; re-scope at ${pull.headSha} (ADR 0058).`,
					),
				};
			}
			wanted = shaped;
		}

		const remote = yield* remoteFor(repo);
		if (remote === null) {
			return unknown(verb, `no git remote in this checkout serves ${repo}`);
		}
		const fetched = yield* fetchRef(remote, `pull/${pr}/head`);
		if (fetched._tag === "Failure") {
			return unknown(verb, `cannot fetch pull/${pr}/head from ${remote}: ${fetched.reason}`);
		}
		const resolved = yield* resolveCommit(wanted);
		if (resolved._tag === "Failure") {
			return unknown(verb, `${resolved.reason} after fetching pull/${pr}/head`);
		}
		if (!prefixMatch(resolved.value, wanted)) {
			return unknown(verb, `git resolved ${wanted} to ${resolved.value}, a different commit`);
		}
		const tip = yield* fetchAndResolve(`${remote}/${pull.baseRef}`);
		if (tip._tag === "Failure") {
			return unknown(verb, `cannot resolve base ${pull.baseRef}: ${tip.reason}`);
		}
		const forked = yield* mergeBase(tip.value, resolved.value);
		if (forked._tag === "Failure") {
			return unknown(
				verb,
				`cannot resolve the merge base of ${pull.baseRef} (${tip.value}) and ${resolved.value}: ${forked.reason}`,
			);
		}
		return {
			_tag: "Bound" as const,
			head: {sha: resolved.value, baseTip: tip.value, mergeBase: forked.value},
		};
	});

/**
 * The stderr line that says which commit the answer was read out of. Evidence, on every answer.
 *
 * The `(base …)` clause names the **merge base** — what every reader of this line has always taken
 * it for. Printing the branch tip there cost three agents a hand-correction each in one lane (#5770).
 */
export const boundLine = (verb: string, head: BoundHead): string =>
	`${verb}: bound to ${head.sha} (base ${head.mergeBase}) — read from the object database, nothing checked out.`;
