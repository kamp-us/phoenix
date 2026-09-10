/**
 * The one exit table every `lane` verb allocates from, so a code means one thing across the group.
 *
 * The five shared seats are **imported from the base, never re-typed** — the discipline
 * `../exit-code-alignment.ts` checks. The lane verbs read a local lane directory and append to its
 * log, so the base's facts they can establish are exactly these: the target is not there, the
 * target was read but is not the shape, the write did not land, a marker landed and does not read
 * back, the read that would have proven any of that failed. `12`+ is this group's own band.
 *
 * **A fold that could not be made never resolves to a plausible state.** An absent lane, an
 * unreadable one, and a lane whose bytes parse but contradict the machine stay distinct codes,
 * because they take opposite remedies: open the lane, fix the tree, fix the record.
 */

import {
	BAD_SECTIONS as SHARED_BAD_SECTIONS,
	BARE_AT_PATH as SHARED_BARE_AT_PATH,
	EMPTY_STDIN as SHARED_EMPTY_STDIN,
	LEAKED_PATH as SHARED_LEAKED_PATH,
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
	READBACK_MISMATCH as SHARED_READBACK_MISMATCH,
	WRITE_UNKNOWN as SHARED_WRITE_UNKNOWN,
} from "../exit-codes.ts";

/**
 * Stdin was read and held nothing — `lane assembly-body`, the group's one verb that takes authored
 * bytes. Distinct from a read that failed, which is `1`: an unread pipe is UNKNOWN, and collapsing
 * it into "empty" would let the guard answer over a body it never saw.
 */
export const EMPTY_STDIN = SHARED_EMPTY_STDIN;

/** The authored body carries a machine-local path headed for a public pull request. */
export const LEAKED_PATH = SHARED_LEAKED_PATH;

/**
 * The authored body IS a bare `@` path reference. Its own seat because the remedies are opposite: a
 * leak is redacted and resent, while a body that is a pointer has to be written first.
 */
export const BARE_AT_PATH = SHARED_BARE_AT_PATH;

/**
 * The lane is not there: no `workflow.json` under the lane directory. A proven absence — the lane
 * was never opened **in the repository's own ledger**: the root a verb reads is derived from the
 * repository the cwd belongs to, so an absence proven from any worktree of the repo is the
 * primary ledger's absence, not that tree's empty one. The base's target seat: the thing the verb
 * was pointed at does not exist.
 */
export const LANE_ABSENT = SHARED_NO_TARGET;

/**
 * The lane was read in full and is not the shape: a `workflow.json` the compiler refuses (each
 * defect named), an `events.jsonl` line that does not parse, or a log the machine cannot replay.
 * The base's section seat widened to a whole on-disk record, on the `review-ui` precedent.
 */
export const MALFORMED_RECORD = SHARED_BAD_SECTIONS;

/**
 * The append did not land, or `lane claim`'s marker write did not. The caller refuses; it never
 * reports the event as recorded, nor the claim as held.
 */
export const APPEND_UNKNOWN = SHARED_WRITE_UNKNOWN;

/**
 * `lane claim`'s marker landed and does not read back as the token this run posted. The comment
 * exists, so it is neither a failed write nor a lost race — it needs a human eye.
 */
export const MARKER_READBACK = SHARED_READBACK_MISMATCH;

/**
 * The lane could not be read, or its absence could not be established. UNKNOWN, never a fresh
 * lane: the read is what makes {@link LANE_ABSENT} and {@link MALFORMED_RECORD} *proven*, so a
 * failed read can be neither.
 */
export const LANE_UNREADABLE = SHARED_PRECONDITION_UNKNOWN;

/**
 * The event is refused and the log is left unappended: the machine holds no cell for it in the
 * task's current state (tea's `NoCellError`), the event is outside the operator's set, the task is
 * not in the active phase, or the workflow is already done. A proven refusal — the loud surface
 * a silently event-swallowing state library never gives its reader.
 */
export const EVENT_REFUSED = 12;

/**
 * The task the event was addressed to is not in this lane's machine, or `--task` was omitted on a
 * lane with more than one task. Its own seat rather than {@link EVENT_REFUSED} because the remedy
 * differs: name a task the machine has, not a different event.
 */
export const TASK_UNKNOWN = 13;

/**
 * The lane directory is already there — a boot or emit over it is refused with nothing written.
 * Resuming an existing lane needs no boot, and silently overwriting a machine mid-drive would
 * corrupt a live fold.
 */
export const LANE_EXISTS = 14;

/**
 * The epic body carries no readable `## Dependencies` topology — there is nothing to emit a machine
 * from. The remedy is planning the epic, so it never shares a seat with a topology that is there
 * and defective.
 */
export const TOPOLOGY_ABSENT = 15;

/** The topology references an issue that is not a child of the epic, and the ref is named. */
export const TOPOLOGY_FOREIGN = 16;

/** The topology's dependency graph holds a cycle, and the ref path is named. */
export const TOPOLOGY_CYCLE = 17;

/**
 * The task's leaf state routes to no shell — `queued`, `blocked`, a `human:*` park, a final, or a
 * name this machine does not recognise. Its own seat because there is nothing to fix in the lane:
 * the remedy is the driver acting on that state (record an event, clear the park), not a re-run.
 */
export const NO_SHELL = 18;

/**
 * The issue a task drives could not be resolved: neither the task name nor the lane id carries an
 * issue number, or the number they carry is proven absent or closed. Separate from
 * {@link TASK_UNKNOWN}: the task IS in the machine, and what is missing is its ground on the board.
 */
export const ISSUE_UNRESOLVED = 19;

/**
 * Exactly one open PR was required to declare it closes the task's issue and zero or several did.
 * A PR that merely quotes the number in prose is not one of them. Never
 * resolved by picking the newest: a brief handed the wrong PR sends a shell to judge or merge
 * someone else's work, so the ambiguity is named and the dispatch stops.
 */
export const PR_AMBIGUOUS = 20;

/**
 * The `lane` argument is not a lane key: an empty key, or a `chore:<name>` whose name is not the one
 * shape a chore lane's directory may carry. Refused before any path is joined and before any read,
 * so a name carrying a separator or a traversal never becomes a directory nobody meant.
 */
export const KEY_MALFORMED = 21;

/**
 * The artifact the event claims is **provably not there**: no open pull request traces to the
 * task's issue and the issue is not one a no-PR outcome is legal on, or — on an epic run's child,
 * which opens no PR — no branch in this tree carries commits naming the child. The event
 * is a self-report nothing corroborates, so the remedy is to route the spawn's outcome as blocked,
 * not to record it.
 *
 * The four proof seats are **artifact-independent**: what a caller must do about "not there", "not
 * finished", "says the other thing" and "several candidates" does not change with the kind of
 * artifact, so the range arms allocate no fifth seat — nor does `lane brief`, which reads a child's
 * range off the same tree before it dispatches a reviewer at it.
 */
export const PROOF_ABSENT = 22;

/**
 * The artifacts are there but not terminal — a required namespace with no verdict that still binds,
 * whether by head (a PR verdict) or by content digest (a child's range verdict). Its own
 * seat because the remedy is the opposite of {@link PROOF_ABSENT}'s: re-read until the review
 * finishes, record nothing in the meantime (`operate` step 3's in-flight rule).
 */
export const PROOF_IN_FLIGHT = 23;

/**
 * The artifact is there and says the other thing — a still-binding `FAIL` under a claimed `PASS`, or
 * under a reviewer's claimed park. Distinct again by remedy: the caller has the event wrong
 * and the machine has a cell for the one the artifact actually supports.
 */
export const PROOF_CONTRADICTED = 24;

/**
 * Several candidates trace to the task: several open pull requests linking its issue, or several
 * lane branches carrying an epic child's commits. Which one the lane owns is not derivable, and
 * picking one would record a DONE against another lane's work — or brief a reviewer at another
 * lane's range — a park, never a guess.
 */
export const PROOF_AMBIGUOUS = 25;

/**
 * The tree is not standing on the run's assembly branch — a detached HEAD, or another branch checked
 * out. Refused before anything is pushed: the branch name is derived from the epic number, so a push
 * from anywhere else would publish a tree this run never assembled.
 */
export const WRONG_BRANCH = 26;

/**
 * The push would not fast-forward — the local head does not contain the published assembly head, so
 * it would drop commits the remote already carries. The assembly branch only ever grows (every
 * landing is a merge onto it), so no force path exists and no flag opens one: the remedy is to fetch
 * and re-merge, never to overwrite.
 *
 * `27` and `28` are skipped rather than taken: the base already speaks for both
 * (`report`'s `QUEUE_UNREADABLE` and `SEARCH_UNREADABLE`), and `exit-code-alignment.ts` reds on a
 * private code that collides with one of the base's.
 */
export const UNSAFE_PUSH = 29;

/**
 * Proven: the push ran and the remote ref is **not** at the local head. Its own seat rather than
 * {@link APPEND_UNKNOWN}'s, because "it did not land" and "whether it landed is unreadable" take
 * opposite remedies — push again, versus re-read before touching anything.
 */
export const REF_NOT_MOVED = 30;

/**
 * Proven: this session does not hold the driver's claim on the lane — another driver won the race,
 * or there is no claim to release. Its own seat rather than `build`'s `15`, which this group already
 * spends on {@link TOPOLOGY_ABSENT}; the two prove different facts and share no remedy.
 *
 * Proven-unclaimed sits here too, on `build claim`'s reading: zero markers means this session does
 * not hold the lane, which is the one fact a driver acts on. The stderr detail keeps unclaimed and
 * foreign apart for a reader; the code does not, because the caller stops either way.
 */
export const CLAIM_NOT_MINE = 31;

/**
 * The token handed to `lane report` is no shell's terminal token — the map in `report.ts` holds no
 * entry for it, so no event can be derived and the log is left unappended. Its own seat rather than
 * {@link EVENT_REFUSED}'s because the remedy differs: pass a token from your shell skill's closed
 * vocabulary, not a different event — silently interpreting an unknown token is the failure class
 * this verb exists to delete.
 */
export const TOKEN_UNRECOGNISED = 32;

/**
 * An epic run's assembly git write was aimed at the **main working tree** — the branch is checked
 * out there, or the verb is standing there. Fail-closed and never overridable: `operate`'s boot
 * used to switch the invoking checkout onto `epic/<n>` and keep it there for the whole run, which
 * parked a human's working tree on the epic branch and left a concurrent epic no tree to assemble
 * in. Its own seat rather than {@link WRONG_BRANCH}'s: that one says the tree is on the wrong
 * branch, this one says the branch is in the wrong tree, and the remedies are opposite — switch,
 * versus `lane assembly` a worktree of the run's own.
 */
export const PRIMARY_CHECKOUT = 33;

/**
 * The assembly branch tracks a ref that is not itself, and clearing that upstream did not take. The
 * shape `git worktree add -b epic/<n> <seat> origin/HEAD` left it behind, recording
 * `branch.epic/<n>.merge = refs/heads/main` and aiming the run's pushes at the default branch.
 * `lane push` now names its target explicitly, so the config can no longer redirect the verb; this
 * code says the seat itself is still aimed at that branch, where a bare `git push` would fire at
 * it.
 *
 * Its own seat rather than {@link REF_NOT_MOVED}'s: that one is read after a push ran and says the
 * remote disagrees, this one is proven before anything is sent.
 */
export const MISDIRECTED_PUSH = 34;

/**
 * The `--cause` handed to `lane report` or `lane transition` is outside the closed park-cause set,
 * or rides on an event that is not `BLOCKED` — refused with the log unappended.
 *
 * Its own seat rather than {@link TOKEN_UNRECOGNISED}'s: that one says the terminal token is
 * unknown and the whole report is unreadable, this one says the event resolved fine and the reason
 * bolted onto it did not, so the remedy is to drop or respell the cause and record the same event.
 * A cause nobody can key on must never be recorded as one that can.
 */
export const CAUSE_UNRECOGNISED = 35;

/**
 * The resume would walk the door out of a park back into a state whose guarded routes all fall
 * straight back through it — the state restored, the budget it needs still spent. Refused with the
 * log unappended, on either budget.
 *
 * Its own seat rather than {@link EVENT_REFUSED}'s: that one says the machine holds no cell, and the
 * remedy is a different event. Here the cell is there and the fold would succeed — it would advertise
 * `active`/`review` on a lane that re-freezes on its next `FAIL`. The
 * remedy is not another event at all but a grant, so a caller reading only the code must not be told
 * to retype the transition. **Which grant differs by axis and the message says which**: a recorded
 * `CLEARED` round for retries — `build clear` where a pull request carries the founder's grant,
 * `lane clear` where the lane has none — and waits granted on this same resume for the wait axis
 * (`recipe unpark`, else `--grant-wait`). Neither clear verb buys a longer wait.
 */
export const RESUME_UNBUDGETED = 36;

/**
 * A booted lane's machine cannot be replaced by the committed template without moving the lane: the
 * log will not replay through the candidate, or it replays to a different leaf state. Nothing was
 * written on either arm.
 *
 * Its own seat rather than {@link MALFORMED_RECORD}'s: that one says a record on disk is not the
 * shape and the remedy is fixing the record, while this one says both records are fine and
 * *disagree* — the remedy is a human deciding what that lane's state should be, never a rewrite the
 * sweep picks.
 */
export const MIGRATION_UNSAFE = 37;

/**
 * A `--class` handed to `lane report` or `lane transition` is outside the closed set the review
 * classes name — refused with the log unappended.
 *
 * Its own seat rather than {@link CAUSE_UNRECOGNISED}'s: a cause is dropped and the same event is
 * recorded, while an unknown class is a routing miss — `--class UI` matched no `class:<name>` arm
 * and fell through to the unclassed target with nothing said, so the lane built as a plain lane and
 * the rendered-visual verdict it owed was never asked for. The remedy is respelling the
 * class, and the event must not land until it is.
 */
export const CLASS_UNRECOGNISED = 38;

/**
 * The directory a relative lanes root would resolve against holds neither `.fabrika` nor `.git` —
 * the verb is not standing in a repo, so the root it would read or write is somewhere nobody meant.
 *
 * Its own seat rather than {@link LANE_ABSENT}'s, and that is the whole point: a drifted cwd used to
 * prove the lane *absent*, which `operate` reads as the boot signal, so a driver whose shell reset
 * into a scratchpad would boot a second ledger over a live lane — duplicate spawns on one issue, the
 * collision the claim machinery exists to prevent. "No lane in this repo" may mean boot;
 * "not a repo at all" never may.
 */
export const NOT_A_REPO = 39;

/**
 * Another writer held the lane's write lock for this writer's whole wait budget, so nothing was
 * validated or appended. Its own seat rather than {@link EVENT_REFUSED}'s because the
 * remedies are opposite: an ordinary refusal says this event is invalid against the state that
 * exists and a different event is wanted, while this one says the event may be exactly right and
 * the caller should retry it once the holder clears. The stderr detail names the lock directory;
 * the code is what lets a shell tell "retry me" from "rethink me" without parsing prose.
 */
export const CONCURRENT_WRITE = 40;

/**
 * No working tree holds the run's assembly branch, so there is nowhere to merge a child into. A
 * proven absence, not an unreadable one: the working trees were listed and none of them is on
 * `epic/<n>`. Its own seat rather than {@link LANE_ABSENT}'s — the lane record is fine and the
 * remedy is `lane assembly`, which places the tree back.
 */
export const ASSEMBLY_UNSEATED = 41;

/**
 * The child's range does not merge into the assembly: git left conflicts, and the merge was aborted
 * with the branch back where it started. The one integration refusal that reaches no merged tree at
 * all, which is why nothing was installed and no validator ran.
 *
 * Its own seat rather than {@link ASSEMBLY_RED}'s: a conflict is two ranges disagreeing on the same
 * lines, and the repair builder resolves it; a red is two ranges that merged cleanly and do not hold
 * together.
 */
export const MERGE_CONFLICT = 42;

/**
 * The merged tree's dependencies could not be reconciled from its own lockfile: the declared
 * `dependencyReconciler` exited non-zero, could not be executed at all, or ran and left a tracked
 * file changed. The clean merge is reset and the assembly branch is unpublished either way.
 *
 * All three are one seat because they take one remedy — the child's dependency declaration is what
 * has to change — and none of them is a claim about the code: no validator ran, so the merged tree
 * was never judged. A reconciliation that rewrites the lockfile is a refusal rather than a repair
 * the assembly quietly carries.
 */
export const RECONCILE_REFUSED = 43;

/**
 * The merged tree failed the repo's own code validators — the semantic collision an epic run exists
 * to catch: two ranges that each passed alone and do not hold together. Proven red, on a tree whose
 * dependencies were reconciled first, so it is the code that failed and not the install.
 *
 * The clean merge is reset, so the recorded `FAIL` names a branch that never carried it.
 */
export const ASSEMBLY_RED = 44;

/**
 * The assembly worktree already held modified tracked files before the merge was attempted, so
 * nothing about the child was ever tried: no merge, no install, no validator.
 *
 * Its own seat because it is neither {@link MERGE_CONFLICT} nor {@link RECONCILE_REFUSED}, and
 * reading it as either charges a child for the driver's tree. Dirt on a tracked path makes
 * `git merge` refuse to overwrite it, which is a non-zero merge indistinguishable from a real
 * conflict; and dirt the merge happens to clear leaves `reconcile`'s post-install probe unable to
 * tell it from a repair the install wrote. Both of those are a `FAIL` that spends the child's retry
 * budget on state the child did not cause — the exact harm this refusal exists to stop, so it
 * sits with the codes the driver records nothing for. The remedy is the seat, not the range.
 */
export const ASSEMBLY_DIRTY = 45;

/**
 * The machine a lane would run is not the machine its issue's board state calls for — the boot half
 * of the incident where an epic booted before it had a plan came up on the single-task coder
 * template and nothing downstream said the lane was wrong.
 *
 * Its own seat rather than {@link LANE_EXISTS} or {@link TOPOLOGY_ABSENT}: nothing is in the way and
 * no topology was read, so both of those send the reader to the wrong remedy. The remedy here is a
 * different verb — `lane emit` for an issue with children, `lane open` for one without.
 */
export const SHAPE_MISMATCH = 46;

/**
 * A grant is unrecordable as asked: the `--grant-wait` handed to `lane transition` is not a whole
 * grant of at least one wait or rides on an event that is not `UNBLOCKED`, or `lane clear` was
 * pointed at a task that still has budget to spend, so there is no round to grant. Refused with the
 * log unappended.
 *
 * Its own seat rather than {@link RESUME_UNBUDGETED}'s: that one says a resume needs a grant and
 * carries none, and the remedy is to add one. This one says the grant itself is unrecordable, and
 * the two must not fold together — a `--grant-wait 0` that landed would raise the budget by nothing
 * while reading as a granted resume, which is the silent no-op the wait axis exists to make
 * loud (the parse refuses the same shape on a log line already).
 */
export const GRANT_REFUSED = 47;

/**
 * The issue a boot was pointed at hangs under a parent, whose lane already carries it as a task —
 * the mirror of {@link SHAPE_MISMATCH}, and the one that guard could not reach, since both facts
 * that guard reads are facts about the issue itself. A child booted its own coder-template ledger
 * while the parent epic's lane held the same number, and nothing reconciled the two.
 *
 * Its own seat rather than {@link SHAPE_MISMATCH}'s, because the remedies are opposite: an epic
 * needs a machine of its own and is booted with `lane emit`, while a child needs no lane at all —
 * the parent's is the one to drive, and a second boot is exactly the harm.
 */
export const LANE_IS_CHILD = 48;

/**
 * A verb whose whole entitlement is a closed issue was pointed at a lane whose issue is still open
 * on the board — `lane archive`, or `lane settle`.
 *
 * An archive moves a lane out of every sweep, so the closed issue is half of what makes that safe:
 * a live lane put beyond `reconcile` and `migrate` is work nothing watches any more. Settling ends the
 * lane outright, and an open issue's closure has said nothing yet. Its own seat because the remedy
 * on both is to drive the lane, not to fix the record.
 */
export const ISSUE_LIVE = 49;

/**
 * `lane archive` was pointed at a lane whose log replays.
 *
 * The other half: only a lane no sweep can ever judge leaves the sweep's scope. A replaying lane is
 * one every sweep judges fine, and archiving it would hide a lane the pipeline still reads. The
 * remedy is to leave it where it is.
 */
export const LOG_REPLAYS = 50;

/**
 * The lanes root already holds as many CLAIMED lanes as `.fabrika.jsonc`'s `laneConcurrencyCap`
 * allows, so the boot is refused with nothing written. The refusal names the claimed seats and the
 * idle unclaimed count separately, because they take different remedies.
 *
 * Its own seat rather than {@link LANE_EXISTS}'s: that one says this lane is already there and the
 * remedy is to drive it, while this one says every seat is taken by *other* lanes somebody is
 * driving and the remedy is to free one — `lane archive` on a lane that is done, `lane release` on a
 * claim nobody is using, or a raised number in the config. No flag opens it, because a cap with an
 * override is the spoken instruction it replaced.
 */
export const CONCURRENCY_CAPPED = 51;

/**
 * A `BLOCKED` was recorded carrying no `--cause`, in a repo whose `.fabrika.jsonc` declares
 * `parkCause.uncaused: "refuse"` — refused with the log unappended.
 *
 * Its own seat rather than {@link CAUSE_UNRECOGNISED}'s: that one says a cause arrived and could not
 * be seated, and the remedy is to drop or respell it. This one says none arrived at all, and the
 * remedy is the opposite — name one. Recording it instead is the defect the code exists to stop: a
 * park with no cause folds to a `Novel` no recipe keys on, so it always spends a human `UNBLOCKED`
 * to say a thing the recorder already knew.
 */
export const PARK_UNCAUSED = 52;

/**
 * The `--rationale` handed to `lane transition` says nothing or rides on an event that is not
 * `UNBLOCKED`, or the one `lane clear` requires is absent or blank — refused with the log
 * unappended. It is mandatory on that verb and optional on this one because a driver's own grant is
 * auditable on its line or nowhere, while a founder's is auditable on the pull request it was
 * posted to.
 *
 * Its own seat rather than {@link CAUSE_UNRECOGNISED}'s, which is the same shape one axis over: a
 * cause is checked against a closed set, while a rationale is prose nothing can validate but its
 * emptiness and the event it sits on. Folding them would send a reader to the park-cause list for a
 * field that has none.
 */
export const RATIONALE_REFUSED = 53;

/**
 * `lane integrate` replayed a colliding child onto the assembly tip and the child's branch would not
 * follow the replayed commits. Nothing was merged and the seat is back where the replay found it.
 *
 * Its own seat rather than {@link MERGE_CONFLICT}'s, which is the collision itself: this one is not
 * about content at all, and its remedy is freeing a branch rather than reconciling two ranges. A
 * working tree still holding the child's branch is the usual reason — `git branch --force` refuses
 * to move a branch another tree stands on — so the park it names is `worktree-holds-branch`, whose
 * clearance a recipe already owns.
 */
export const CHILD_UNSEATED = 54;

/**
 * A queue re-fold arrived before the wait axis's elapsed-time floor — refused with the log
 * unappended, and the wait left unspent.
 *
 * The budget in `../wait-budget.ts` counts re-folds, so without a floor it measures how fast a
 * driver passes rather than how long a PR has sat: lane 6915 spent two of three waits inside roughly
 * ninety seconds behind a clean queue. The refusal is what makes the count measure a dwell instead,
 * and it names the seconds still to run so a driver reads "the wait is intact", never "the wait is
 * lost".
 *
 * Its own seat rather than {@link EVENT_REFUSED}'s: that one says the machine holds no cell for this
 * event and the remedy is a different event, while this one says the cell is exactly right and the
 * remedy is only time. It also covers the unreadable clock — an `at` on the task's last line that
 * parses as no date — because elapsed time is then UNKNOWN, and an UNKNOWN floor may not resolve to
 * "cleared".
 */
export const WAIT_TOO_SOON = 55;

/**
 * The issue the assembly PR's prose was asked for is not an epic — it carries no `type:epic`.
 *
 * Its own seat rather than {@link ISSUE_UNRESOLVED}'s: the issue resolved fine, and what is wrong is
 * which issue was named. A non-epic's title would take a `chore`/`fix` prefix and the `(epic)` scope
 * would be a lie about a subject that is going to land on `main` — so the refusal names the number
 * rather than deriving a title nobody meant.
 */
export const NOT_AN_EPIC = 56;

/**
 * The assembled `## About this epic` section is one `build pr`'s body guard would refuse — a closing
 * keyword the swap did not reach, or a classification claim the block quote did not cover, each
 * named.
 *
 * Both should be impossible while the swap list matches that module's `CLOSING_RE` and the lifted
 * text stays quoted, and this seat is what keeps it so: the section is read back through the guard's
 * own predicates, and the refusal is fail-closed rather than an assumption that the two still agree.
 * The remedy is a person's — reword the epic's Problem paragraph, or write the section by hand. The
 * title is unaffected and a second call with `--field title` still answers.
 */
export const ABOUT_UNSAFE = 57;

/**
 * The assembly PR body handed to `lane assembly-body` carries no closing keyword aimed at the epic —
 * refused, and nothing is printed for a `gh pr create` to open.
 *
 * An epic run is one branch and one PR, so that PR is the run's landing: a tail merging as
 * `Part of #<epic>`, or closing only its children, folds the lane to `shipped` over an epic the
 * board still calls open, and an operator re-dispatched on it parks on `LANE-TERMINAL` with no door
 * out. Its own seat rather than {@link MALFORMED_RECORD}'s, which is a record on disk:
 * nothing here is on disk yet, and the remedy is the author's — write `Fixes #<epic>` into the body,
 * or do not open the run's PR yet.
 */
export const TAIL_NOT_CLOSING = 58;

/**
 * The tree behind the brief's own `fabrika:` entrypoint does not carry a lane verb the brief
 * instructs the shell to run — so the brief is not emitted and no shell is spawned.
 *
 * Its own seat rather than {@link LANE_UNREADABLE}'s, which is the entrypoint the driver could not
 * resolve at all: this one resolved, is node-runnable, and names a tree whose copy of this CLI is
 * older than the contract the brief hands out. An epic run cuts its assembly branch once and every
 * child shell runs that branch's own in-tree fabrika, so a lane verb that landed on the trunk after
 * the cut is absent there — the shell does real work, produces a real verdict, and cannot record it.
 * The remedy is the driver's `lane refresh`, named on the refusal beside every missing verb.
 */
export const BRIEFED_VERB_ABSENT = 59;

/**
 * An issue-keyed boot was pointed at an issue the board says already had a lane — refused with
 * nothing written.
 *
 * A lane's ledger is the whole of its state and it is gitignored, so deleting the directory and
 * booting again mints a lane at a full repair budget with no record anywhere that a round was
 * granted. That is how one frozen lane's spent budget came back, and a successor driver cannot tell
 * the rebuilt ledger from a first boot.
 *
 * Its own seat rather than {@link LANE_EXISTS}'s, which says the directory is in the way and the
 * remedy is to drive it; here nothing is in the way and that is the problem. Rather than
 * {@link SHAPE_MISMATCH}'s or {@link LANE_IS_CHILD}'s too, whose remedies are a different verb and a
 * different lane: the remedy here is neither, because a spent repair budget comes back only through
 * a recorded round grant.
 */
export const PRIOR_LANE = 60;
