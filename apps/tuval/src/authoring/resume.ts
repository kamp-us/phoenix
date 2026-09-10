/**
 * `resume` — what a spawner sends a process it just brought back from a checkpoint, written as the
 * author's own events (`../durability/resume.ts` is the kernel half that dispatches them).
 *
 * It is sugared rather than left to a spread because it reads and answers nothing but the author's
 * own vocabulary: the checkpointed state on the way in, one of the `update` table's own event names
 * on the way out. A restored process starts on its loaded state with no Cmds — Demlik refuses a
 * rehydrating `init` that emits — so this is the only door an authored program has back into the
 * world after a restart, and #7877 is what a missing one costs.
 *
 * **`configChanged` is deliberately *not* sugared beside it.** Its argument is the replacement
 * registry row, which is the shape this whole layer exists to keep out of an author's file, and
 * there is nothing honest to hand an author in its place until a program can read another
 * generation's args as args. It stays reachable by spread, as `define-program.ts` says every
 * unsugared field does, and `.patterns/tuval-authored-programs.md` writes the spread out.
 */

import type {AnyAuthoredProgram, AuthoredEvent} from "./define-program.ts";

/**
 * One Msg a resume may send. The name is a cell the author's own `update` holds — a port arrival
 * is not one of these, since nothing arrived — and the payload stays open, because an own event's
 * payload is whatever its cell reads.
 */
export type ResumeEvent<U> = AuthoredEvent & {readonly type: keyof U & string};

/** What an author writes: their checkpointed state in, the events a restart owes them out. */
export type AuthoredResume<S, U> = (state: S) => ReadonlyArray<ResumeEvent<U>>;

/**
 * The row's `resume`, which takes the state as `unknown` because the kernel hands it the loaded
 * value. An author who declared none leaves the field off the row entirely, and a row with no
 * `resume` has nothing to resume.
 */
export const compileResume = (
	authored: AnyAuthoredProgram,
): ((state: unknown) => ReadonlyArray<AuthoredEvent>) | undefined =>
	authored.resume === undefined
		? undefined
		: (state: unknown) => authored.resume?.(state) ?? ([] as ReadonlyArray<AuthoredEvent>);
