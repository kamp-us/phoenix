/**
 * Exit allocations for build. See ./command.ts help for caller semantics.
 * Shared meanings stay imported so their values cannot drift.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	CLASSIFIED as SHARED_CLASSIFIED,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

export const EMPTY_STDIN = SHARED_EMPTY_STDIN;
export const BAD_SECTIONS = SHARED_BAD_SECTIONS;
export const LEAKED_PATH = SHARED_LEAKED_PATH;
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;
/** An absent target is proven; a failed read must use PRECONDITION_UNKNOWN. */
export const ZERO_SCOPE = SHARED_NO_TARGET;
export const WRITE_UNKNOWN = SHARED_WRITE_UNKNOWN;
export const READBACK_MISMATCH = SHARED_READBACK_MISMATCH;
export const OFF_VOCABULARY = SHARED_CLASSIFIED;
export const PRECONDITION_UNKNOWN = SHARED_PRECONDITION_UNKNOWN;

/**
 * `12` is a **retired seat, deliberately left empty.** It was "not in a linked worktree", and the
 * 2026-08-13 ruling dropped fabrika's opinion on where a lane runs. Nothing is renumbered
 * into it: a reader of an old transcript must not find `12` meaning something new.
 */

export const DIRTY_TREE = 13;
export const WRONG_LANE = 14;
/**
 * Proven: this session does not hold the claim — lost, foreign, or none exists at all.
 *
 * Proven-unclaimed sits here too: zero markers means this session does not hold the claim, which is
 * the one fact every consumer acts on. The stderr detail separates unclaimed from foreign for a
 * reader; the code deliberately does not, because the caller's action is identical.
 */
export const CLAIM_NOT_MINE = 15;
export const BLOCKED = 16;
export const REF_NOT_MOVED = 17;
export const VALIDATION_RED = 18;
export const UNSAFE_PUSH = 19;
/**
 * Proven: not admitted on the **scope axis** — out of scope.
 *
 * Campaign membership and nothing else. It is a sibling of {@link AUDIENCE_NOT_AGENT}, not the same
 * question: the two have different remedies, so they never collapse onto one code. Nor does either
 * borrow {@link BLOCKED} — a scope refusal is not blockedness — or {@link PRECONDITION_UNKNOWN}: `20`
 * and `21` are *proven* refusals, while a read that failed has proven nothing.
 */
export const OUT_OF_SCOPE = 20;
export const AUDIENCE_NOT_AGENT = 21;
/**
 * Proven: every changed file falls outside all three surfaces' validators — nothing is checkable.
 *
 * A *proven* refusal like `20`/`21`, not a borrowed {@link PRECONDITION_UNKNOWN}: the diff read
 * succeeded and the classification is complete, so the fact established is about the tree, not about
 * a read that failed. Its own seat because the caller's remedy is unique — widen no surface, split
 * the diff or extend a validator.
 */
export const UNCLASSIFIED_DIFF = 22;
/**
 * Proven: the local head does not contain the published remote head — this push would drop commits.
 *
 * A *proven* refusal about the two commits, so it sits with `17`/`19`/`20`/`21` and never on
 * {@link PRECONDITION_UNKNOWN}, which is reserved for a read that failed. Its own seat rather than
 * `19`'s because the remedy differs: `19` says "pass the lease", this one says "rebase, or say you
 * mean it" — collapsing them would make the fix instruction ambiguous.
 *
 * Overlapping `epic`'s own `23` is the same safe overlap `20`/`21` already rely on — the rule is
 * `plan/codes.ts`'s: import a code when two groups prove the *same* fact, and an exit code is
 * otherwise read off the command that produced it. No `epic` verb can prove a push's containment.
 */
export const HEAD_DROPS_REMOTE = 23;
/**
 * Proven: `git commit` ran and HEAD did not move — no commit was created.
 *
 * The commit-side twin of `17`, and seated separately for the same reason `23` is not `19`: the
 * remedy differs. `17` says the remote did not take the head; this one says no head was made, so the
 * fix is git's own refusal (an empty index, a hook that blocked) rather than anything about a ref.
 * It is never {@link WRITE_UNKNOWN}: HEAD was re-read and compared, so the absence is *proven*, and
 * fusing "no commit exists" with "a commit may exist" is the fusion this group refuses everywhere
 * else.
 */
export const COMMIT_NOT_CREATED = 24;
/**
 * Proven: the invoking account may not clear a cap — outside the configured grant-author set, or
 * below `write` at the repository ACL.
 *
 * One seat for both clauses because they answer one question, "may this account grant?", and a
 * caller's next move is the same either way: get authority, then re-run. Its own seat rather than a
 * borrowed `21`: that code is about the *issue's* audience label, and this one is about who may hold
 * founder authority — the remedies share nothing. It is never {@link PRECONDITION_UNKNOWN}: the
 * config, the memberships and the ACL were read in full, so the refusal is a fact about the account.
 */
export const GRANT_UNAUTHORIZED = 25;
export const AUTHORIZATION_VOID = 26;
/**
 * Proven: the grant is recorded on the PR and the local lane did not take it.
 *
 * Never {@link WRITE_UNKNOWN}: the remote half landed and read back, so the outcome is known and
 * partial. The lane freezes a round early until a re-run reconciles it, which is the conservative
 * direction and a state an operator must be able to see rather than infer.
 *
 * `27` and `28` are the base's (`QUEUE_UNREADABLE`, `SEARCH_UNREADABLE`), so the next free seat is
 * `29` — a group never re-uses a number the base already spoke for.
 */
export const LOCAL_LANE_UNWRITTEN = 29;
/**
 * Proven: not admitted on the **type axis** — the deliverable is not a pull request a build lane
 * produces.
 *
 * The third sibling of {@link OUT_OF_SCOPE} and {@link AUDIENCE_NOT_AGENT}, and seated apart from
 * both for the reason they are seated apart from each other: the remedy is unlike either. `20` says
 * flip the campaign state cell, `21` says re-label the audience, and this one says the work belongs to another
 * skill's lane — `/adr` for a decision, `plan-epic` for an epic — or, on a decision whose choice a
 * founder already recorded, that the claim must cite that ruling comment. Borrowing `21` is what the
 * code did before there was a fence at all, and it named the wrong objection: an operator sent to
 * re-label a decision `ready-for:agent` would satisfy `21` and still be building the wrong artifact.
 */
export const TYPE_NOT_BUILDABLE = 30;
/**
 * Proven: the claim's mode and the child's standing range verdict disagree.
 *
 * Two directions, one seat, because one fact is established either way — *this number's build state
 * is not what the claim says it is*. A fresh claim refuses on any standing verdict, `PASS` as well as
 * `FAIL`; `--resume` refuses on a child holding no `FAIL`. That is unlike every neighbouring
 * seat: `20`/`21`/`30` are about whether an issue may be built at all, and this one is about whether
 * it has been built already. The route out is not uniform — a `FAIL` has a repair lane, a `PASS` has
 * only the epic driver's fold — so each refusal line names its own.
 *
 * Never {@link PRECONDITION_UNKNOWN}: the comments were read in full and the standing verdicts folded,
 * so the refusal is a fact about the child. A read that *failed* stays `11`, and a fence that could
 * not read its input must never resolve to "no prior build".
 */
export const PRIOR_BUILD_MISMATCH = 31;
/**
 * Proven: not admitted on the **criteria axis** — the issue's body carries no readable
 * `### Acceptance criteria` block, so there is no contract to build against.
 *
 * The fourth sibling of {@link OUT_OF_SCOPE}, {@link AUDIENCE_NOT_AGENT} and
 * {@link TYPE_NOT_BUILDABLE}, seated apart from all three because the remedy is unlike any of them:
 * `20` says flip a campaign's state cell, `21` says re-label the audience, `30` says take the work
 * to another skill, and this one says the issue body itself has to be repaired — `triage enrich` to
 * author a block that is absent, `triage repair-criteria` to straighten one whose heading drifted.
 * Nothing a build lane may do from its own branch, which is exactly why it refuses before one is cut.
 *
 * Never {@link PRECONDITION_UNKNOWN}: the body was read in full and the wire's three-answer read
 * returned a positive token, so the refusal is a fact about the issue. A body that could not be read
 * never reaches this axis.
 */
export const NO_ACCEPTANCE_CRITERIA = 32;
/**
 * Proven: a working tree still holds this number's lane branch, and the board licenses no release.
 *
 * A *proven* refusal about the board — the ticket is not terminal and no authorized adopt marker
 * says the holding lane's session is gone — so it never borrows
 * {@link PRECONDITION_UNKNOWN}, which is for a read that failed. Its own seat rather than
 * {@link WRONG_LANE}'s: `14` says *you* are standing in the wrong tree, and this says another tree
 * is standing where you need to be, with the board declining to move it.
 */
export const WORKTREE_HELD = 33;
/**
 * Proven: the board attests no survivor among a child's lane branches, so none is superseded.
 *
 * A *proven* refusal about the board — the markers were read in full and the ACL resolved — so it
 * never borrows {@link PRECONDITION_UNKNOWN}. Its own seat rather than {@link CLAIM_NOT_MINE}'s:
 * `15` is about the caller's own claim, and this verb runs against a branch its lane never cut, so
 * whether the caller holds anything is not the question. The remedy is unlike every neighbour's —
 * the live lane re-claims through `build resume-child`, and until some authorized marker carries a
 * candidate's lane nonce there is nothing to rename.
 */
export const SURVIVOR_UNATTESTED = 34;
/**
 * Proven: the replacement disclosure drops a standing entry the marker still owes.
 *
 * A *proven* refusal about two artifacts both read in full — the standing marker's disclosure and
 * the section on stdin — so it never borrows {@link PRECONDITION_UNKNOWN}. Its own seat rather than
 * {@link BAD_SECTIONS}'s: `4` says the bytes on stdin are not a section, and this says they are a
 * perfectly well-formed section that discloses less than the round before it. The remedies share
 * nothing — `4` is a rewrite of the grammar, this is carrying an entry forward — and a `4` here
 * would send an author to re-read a shape that was never wrong.
 */
export const DISCLOSURE_INCOMPLETE = 35;
/**
 * Proven: a lane branch that already exists does not contain the base this run resolved.
 *
 * A *proven* refusal about two commits both read in full — the fetched base and the branch's merge
 * base with it — so it never borrows {@link PRECONDITION_UNKNOWN}. Its own seat rather than
 * {@link WRONG_LANE}'s: `14` says the checked-out branch belongs to another lane, and this says the
 * branch is this lane's own and was cut somewhere else. The remedy is unlike any neighbour's, and it
 * is a git act rather than a verb: rebase the branch onto the base, or delete it when it carries
 * nothing worth keeping. `build retire-branch` is NOT the route — it renames *superseded* branches
 * out of `build/`, so over the one branch a `36` describes it answers `none` and renames nothing,
 * and over two it seats the survivor on the nonce the live claim carries, which is the offending
 * branch itself. The fact this code states is the one an epic child cut off the trunk had nobody to
 * state: the idempotent re-run cannot be the recovery when the re-run is what hides the wrong base.
 */
export const BASE_MISMATCH = 36;
