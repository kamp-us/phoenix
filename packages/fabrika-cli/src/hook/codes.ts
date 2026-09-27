/**
 * The one exit table every `hook` verb allocates from.
 *
 * `hook codes` exposes {@link HOOK_EXIT_TABLE}; each verb's `--help` states what triggers its codes.
 *
 * **`2` is allocated by nothing, here or in any other group, and this is the group that makes it a
 * hard rule.** On `PreToolUse` exit `2` is the harness's one blocking code (`./harness-exit.ts`), so
 * a fabrika verb that seats any meaning on it denies a tool call as a side effect of its exit
 * status. `NO_IMPLEMENTATION` used to sit there, which made a fabrika that could not bootstrap block
 * every `Task`/`Workflow` spawn — the inverse of the ruled polarity, where a hook whose verb never
 * ran fails open and lets the harness event proceed.
 *
 * {@link EMPTY_STDIN} is *imported* from `report`, not restated as `3`: it is the same fact the
 * writing verbs already seat there, so the alignment is by identity rather than by assertion
 * (`../exit-code-alignment.ts`). The two private seats sit at `12`+ because everything below is
 * occupied in the base table.
 *
 * Note what is NOT here: a seat for "the verb never ran". `127` is the shell's, and a dispatch that
 * never reached this process cannot allocate from a table this process owns — which is exactly why
 * the dispatch-failure policy lives in the hook declaration and not in a verb
 * (`claude-plugins/fabrika/docs/hook-surface.md`, *The dispatch-failure policy point*).
 */

import {EMPTY_STDIN as SHARED_EMPTY_STDIN} from "../exit-codes.ts";
import {NO_IMPLEMENTATION} from "../verb.ts";

/** The answer is on stdout. Restated because {@link HOOK_EXIT_TABLE} spans the whole matrix. */
const ANSWER = 0;
/** Usage error, or the verb failed to run. */
const FAILED = 1;

/** Stdin was read and held nothing. An absent envelope is not an envelope to judge. */
export const EMPTY_STDIN = SHARED_EMPTY_STDIN;

/**
 * Bytes arrived on fd 0 and they are not a harness hook envelope — unparseable JSON, a non-object,
 * or an object missing a field every captured envelope carries. A **proven** negative.
 */
export const MALFORMED_ENVELOPE = 12;

/**
 * fd 0 carried nothing readable, or the read itself failed. The envelope is **UNKNOWN**.
 *
 * Deliberately not {@link MALFORMED_ENVELOPE} and deliberately not `1`: "I could not see it" is not
 * "I saw it and it was wrong", and `1` is also what a bad flag returns, so a proven outcome seated
 * there is unreadable as proof.
 */
export const ENVELOPE_UNKNOWN = 13;

/**
 * A readable envelope arrived, and it is not the event this verb judges.
 *
 * Kept apart from {@link MALFORMED_ENVELOPE} because the envelope is fine — the *routing* is wrong,
 * which is a declaration bug (a hook wired to an event its verb does not answer), not a bad payload.
 * Seating both on one code would let a mis-wired hook read as a harness that sends garbage.
 */
export const WRONG_EVENT = 14;

/**
 * A readable `WorktreeCreate` envelope arrived and no worktree can be planned from it — an absent or
 * relative `cwd`, an absent `name`, or a `name` that is not a plain slug.
 *
 * Apart from {@link MALFORMED_ENVELOPE} because the envelope is well-formed: every field
 * `../hook/envelope.ts` requires is present, and it is the *per-event* half this verb needs that is
 * unusable. Collapsing them would report a harness sending garbage when it sent a fine envelope.
 */
export const UNPLANNABLE_WORKTREE = 15;

/**
 * The pre-branch `git fetch` failed, so the base is possibly stale and nothing was created.
 *
 * Its own seat because it is the one refusal that protects a *correctness* property rather than the
 * provisioning: branching a lane off a cached tip silently bases it on state missing a sibling's
 * just-merged commit, and the two collide only at ship time.
 */
export const BASE_FETCH_FAILED = 16;

/** `git worktree add` failed. The tree does not exist, so no path is emitted — the verb refuses. */
export const WORKTREE_ADD_FAILED = 17;

/**
 * The tree was created and its deps were **not** provisioned — `node_modules/.pnpm` is absent after
 * `git worktree add` returned.
 *
 * The whole point of the hook is that this state never reaches an agent, so it is a refusal and not
 * a warning: the `post-checkout` install clean-SKIPs at exit 0 when the PATH-stripped hook env has
 * no toolchain, which makes a successful `git worktree add` byte-identical to a provisioned one.
 * Checking the artifact is the only way to tell them apart.
 */
export const DEPS_NOT_PROVISIONED = 18;

/**
 * A readable envelope arrived and the working tree its `cwd` belongs to could NOT be established.
 *
 * A guard that could not read its own ground has judged nothing, so this seat is a **fail-open**:
 * every non-blocking exit shows stderr to the user and lets the tool call proceed, which is what the
 * dispatch-failure policy asks of a defence that is absent. It is deliberately not `0` — a silent
 * fail-open is the one thing that policy bans — and deliberately not
 * {@link MALFORMED_ENVELOPE}: the envelope was fine and the filesystem underneath it was not.
 */
export const GROUND_UNKNOWN = 19;

/**
 * The plugin source directory was read and its primary worktree is in no state to be advanced — it
 * is off its default branch, on a detached HEAD, diverged, or carrying uncommitted work that the
 * incoming commits also change.
 *
 * Uncommitted work **outside** the incoming commits' paths is not one of those states and does not
 * reach this code: `git merge --ff-only` takes that move and leaves the work alone, so refusing it
 * left a checkout carrying one standing local-only edit behind forever.
 *
 * A **proven** outcome, and deliberately not {@link GROUND_UNKNOWN}: the ground was read fine and
 * says the move would not be safe. Nothing was moved, and the reason is on stderr, which is the
 * whole point of the seat — a plugin source that stops advancing is exactly the silent state
 * `hook plugin-sync` exists to make loud, so it may never be reported as a clean pass.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9459#issuecomment-5745160952
 */
export const SYNC_REFUSED = 20;

/**
 * The `git fetch` against the plugin source's remote failed, so nothing current was read.
 *
 * Apart from {@link SYNC_REFUSED} because no refusal was proven: an unfetchable remote leaves the
 * comparison **UNKNOWN**, and an offline session must not read as "the source is already current".
 */
export const REMOTE_UNREADABLE = 21;

/**
 * The fast-forward was planned from facts that permitted it and the merge itself failed.
 *
 * Its own seat because it is the one arm where the plan and the tree disagree: every precondition
 * read clean and git still refused, which means the worktree changed under the read — a sibling
 * session, a human at a terminal. The remedy is to run it again, not to force anything, so it must
 * not collapse into {@link SYNC_REFUSED}, whose remedy is a human deciding where that checkout sits.
 */
export const FAST_FORWARD_FAILED = 22;

/**
 * The CLI's version could not be compared with the plugin's declared minimum — no plugin root was
 * given, or the floor file or a version in it could not be read. **UNKNOWN**, never a pass: the
 * comparison was not made, so nothing shows the CLI is new enough.
 */
export const FLOOR_UNKNOWN = 23;

/** The verb never ran (unresolved binary). The shell's, not this process's — no constant owns it. */
const NEVER_RAN = 127;

/** One row of the shared matrix: a code and the single meaning it carries across the group. */
export interface ExitCodeRow {
	readonly code: number;
	readonly meaning: string;
}

/** The whole matrix in ascending order — the machine-readable form of the group's exit contract. */
export const HOOK_EXIT_TABLE: ReadonlyArray<ExitCodeRow> = [
	{code: ANSWER, meaning: "the answer is on stdout"},
	{code: FAILED, meaning: "usage error, or the verb failed to run"},
	{code: EMPTY_STDIN, meaning: "stdin was read and held nothing"},
	{
		code: MALFORMED_ENVELOPE,
		meaning: "stdin held bytes that are not a harness hook envelope",
	},
	{code: ENVELOPE_UNKNOWN, meaning: "fd 0 could not be read — UNKNOWN, never malformed"},
	{code: WRONG_EVENT, meaning: "the envelope is a harness event this verb does not judge"},
	{code: UNPLANNABLE_WORKTREE, meaning: "the envelope names no worktree this verb can create"},
	{code: BASE_FETCH_FAILED, meaning: "the base ref could not be fetched — the base would be stale"},
	{code: WORKTREE_ADD_FAILED, meaning: "`git worktree add` failed — no worktree exists"},
	{code: DEPS_NOT_PROVISIONED, meaning: "the worktree was created and its deps were not installed"},
	{
		code: GROUND_UNKNOWN,
		meaning: "the working tree the envelope's cwd belongs to could not be established",
	},
	{
		code: SYNC_REFUSED,
		meaning: "the plugin source's primary worktree is in no state to be advanced",
	},
	{code: REMOTE_UNREADABLE, meaning: "the plugin source's remote could not be fetched — UNKNOWN"},
	{
		code: FAST_FORWARD_FAILED,
		meaning: "the planned fast-forward failed — the tree changed under it",
	},
	{
		code: FLOOR_UNKNOWN,
		meaning: "the CLI could not be compared with the plugin's minimum version — UNKNOWN",
	},
	{code: NO_IMPLEMENTATION, meaning: "no implementation could be resolved"},
	{code: NEVER_RAN, meaning: "the verb never ran (unresolved binary)"},
];
