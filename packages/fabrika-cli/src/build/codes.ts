/**
 * The one exit table all fifteen `build` verbs allocate from, so a code means one thing across this
 * group whichever verb produced it.
 *
 * **The overlap with `report` is re-exported, never re-typed** — the discipline `review/codes.ts`
 * states in full: an aligning group *imports* the base's constant, so a drift is unrepresentable
 * rather than merely detectable. This group shares nine seats over `3`-`11` and adds its own `13`-`24`
 * for facts about the lane — the tree, the claim, the commit, the push, the validators, and the two
 * admission axes — that no writing verb has.
 *
 * `0`, `1`, `2` and `127` are reserved by the interface convention (`../verb.ts`, `../bin.ts`).
 */

import {
	BAD_SECTIONS as REPORT_BAD_SECTIONS,
	BARE_AT_PATH as REPORT_BARE_AT_PATH,
	CLASSIFIED as REPORT_CLASSIFIED,
	EMPTY_STDIN as REPORT_EMPTY_STDIN,
	LEAKED_PATH as REPORT_LEAKED_PATH,
	NO_TARGET as REPORT_NO_TARGET,
	PRECONDITION_UNKNOWN as REPORT_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as REPORT_READBACK_MISMATCH,
	WRITE_UNKNOWN as REPORT_WRITE_UNKNOWN,
} from "../report/codes.ts";

/** Stdin was read and held nothing. Distinct from a read that failed, which is `1`. */
export const EMPTY_STDIN = REPORT_EMPTY_STDIN;
/** A required section is missing, malformed, empty, or out of place — authored, or derived from. */
export const BAD_SECTIONS = REPORT_BAD_SECTIONS;
/** The authored text carries a machine-local path, unredacted. */
export const LEAKED_PATH = REPORT_LEAKED_PATH;
/** The authored text is a bare `@` path reference — not redactable, so a second code. */
export const BARE_AT_PATH = REPORT_BARE_AT_PATH;
/**
 * Zero scope: the target is **proven** absent (404) or closed, or there is nothing to judge.
 *
 * *Proven* is the operative word, and the split against {@link PRECONDITION_UNKNOWN} is the one the
 * whole group rests on: a 404 is a verdict about the repository, a 5xx is a verdict about nothing.
 * No verb fuses them, and no message here is worded "does not exist, or is not readable".
 */
export const ZERO_SCOPE = REPORT_NO_TARGET;
/** A write was attempted and its outcome could not be proven — UNKNOWN, deliberately not `1`. */
export const WRITE_UNKNOWN = REPORT_WRITE_UNKNOWN;
/** The write landed but the read-back does not match; the artifact exists and needs a human. */
export const READBACK_MISMATCH = REPORT_READBACK_MISMATCH;
/** A value off its closed vocabulary, or a classification claim where none is permitted. */
export const OFF_VOCABULARY = REPORT_CLASSIFIED;
/** A required read or validator execution failed — nothing was written, no outcome is proven. */
export const PRECONDITION_UNKNOWN = REPORT_PRECONDITION_UNKNOWN;

/**
 * `12` is a **retired seat, deliberately left empty.** It was "not in a linked worktree", and the
 * 2026-08-13 ruling on #5386 dropped fabrika's opinion on where a lane runs. Nothing is renumbered
 * into it: a reader of an old transcript must not find `12` meaning something new.
 */

/** Proven: the tree was dirty at a `--require-clean` open. An unauthored hunk is not ours (#2666). */
export const DIRTY_TREE = 13;
/** Proven: the checked-out branch does not belong to this lane's claim (the lane-identity rule). */
export const WRONG_LANE = 14;
/**
 * Proven: this session does not hold the claim — lost, foreign, or none exists at all.
 *
 * Proven-unclaimed sits here too: zero markers means this session does not hold the claim, which is
 * the one fact every consumer acts on. The stderr detail separates unclaimed from foreign for a
 * reader; the code deliberately does not, because the caller's action is identical.
 */
export const CLAIM_NOT_MINE = 15;
/** Proven: the issue is blocked — the open dependency edge is named on stderr. */
export const BLOCKED = 16;
/** Proven: the push completed but the remote ref did not move. */
export const REF_NOT_MOVED = 17;
/** Proven: this tree's validation is red. */
export const VALIDATION_RED = 18;
/** Refused: the requested push is unsafe (detached HEAD, or non-fast-forward without a lease). */
export const UNSAFE_PUSH = 19;
/**
 * Proven: not admitted on the **scope axis** — out of focus (ADR 0245).
 *
 * Campaign membership and nothing else. It is a sibling of {@link AUDIENCE_NOT_AGENT}, not the same
 * question: the two have different remedies, so they never collapse onto one code. Nor does either
 * borrow {@link BLOCKED} — a scope refusal is not blockedness — or {@link PRECONDITION_UNKNOWN}: `20`
 * and `21` are *proven* refusals, while a read that failed has proven nothing.
 */
export const OUT_OF_FOCUS = 20;
/** Proven: not admitted on the **audience axis** — the `ready-for:` label is not agent, or absent (#4780). */
export const AUDIENCE_NOT_AGENT = 21;
/**
 * Proven: every changed file falls outside all three surfaces' validators — nothing is checkable.
 *
 * A *proven* refusal like `20`/`21`, not a borrowed {@link PRECONDITION_UNKNOWN}: the diff read
 * succeeded and the classification is complete, so the fact established is about the tree, not about
 * a read that failed. Its own seat because the caller's remedy is unique — widen no surface, split
 * the diff or extend a validator (#5229).
 */
export const UNCLASSIFIED_DIFF = 22;
/**
 * Proven: the local head does not contain the published remote head — this push would drop commits.
 *
 * A *proven* refusal about the two commits, so it sits with `17`/`19`/`20`/`21` and never on
 * {@link PRECONDITION_UNKNOWN}, which is reserved for a read that failed. Its own seat rather than
 * `19`'s because the remedy differs: `19` says "pass the lease", this one says "rebase, or say you
 * mean it" — collapsing them would make the fix instruction ambiguous (#5222).
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
 * else (#5484).
 */
export const COMMIT_NOT_CREATED = 24;
/**
 * Proven: the invoking account is not in the repo's configured cap-clear grant-author set.
 *
 * Its own seat rather than a borrowed `21`: that code is about the *issue's* audience label, and
 * this one is about who the repo configured to hold founder authority — the remedies share nothing.
 * It is never {@link PRECONDITION_UNKNOWN}: the config and the memberships were read in full, so the
 * refusal is a fact about the account (#5959).
 */
export const GRANT_UNAUTHORIZED = 25;
/** Proven: the quoted authorization is empty or undated — a bare stamp is void (#4938). */
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
