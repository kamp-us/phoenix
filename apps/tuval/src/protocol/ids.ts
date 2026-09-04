/**
 * The identifiers and scalars the wire carries.
 *
 * `ProcessId` and `ProgramId` are re-declared here rather than imported. The protocol module is
 * independent of the kernel slices by construction — it may not reach into `src/process/`, and the
 * founder's 2026-09-03 walk on #7637 keeps it independent of the spell registry too. Re-declaring
 * costs nothing at the type level: `Schema.brand` is keyed on the literal brand string, so
 * `"tuval/ProcessId"` here and `"tuval/ProcessId"` in `src/process/process.ts` are one type to the
 * checker, and a kernel id flows onto the wire without a cast.
 */

import {Schema} from "effect";

/** The client-minted correlation id on a call and its reply. */
export const CallId = Schema.String.pipe(Schema.brand("tuval/CallId"));
export type CallId = typeof CallId.Type;

export const WindowId = Schema.String.pipe(Schema.brand("tuval/WindowId"));
export type WindowId = typeof WindowId.Type;

export const WorkspaceId = Schema.String.pipe(Schema.brand("tuval/WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const ProcessId = Schema.String.pipe(Schema.brand("tuval/ProcessId"));
export type ProcessId = typeof ProcessId.Type;

export const ProgramId = Schema.String.pipe(Schema.brand("tuval/ProgramId"));
export type ProgramId = typeof ProgramId.Type;

/** A monotonic counter on desk state: a `Patch` applies only over the revision it follows. */
export const Revision = Schema.Number.check(Schema.isUint32());
export type Revision = typeof Revision.Type;

/**
 * How recently the kernel last touched a window or a process row: the higher the stamp, the more
 * recent. A counter rather than a `lastFocusedAt` timestamp, for the reason `Revision` is one — the
 * kernel already counts and holds no clock, a counter is deterministic under test, and the page
 * only ever compares two stamps, so a wall time would buy nothing and cost clock skew between the
 * kernel and the page. `recency.ts` mints it.
 */
export const Recency = Schema.Number.check(Schema.isUint32());
export type Recency = typeof Recency.Type;

/** A spell path: at least one segment, lowercase English words the registry keys on. */
export const SpellPath = Schema.Array(Schema.String).check(Schema.isMinLength(1));
export type SpellPath = typeof SpellPath.Type;
