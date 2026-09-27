/**
 * The spell: one addressable command a client can call by path (#7617 R1.1). The shape is the
 * founder's `@usirin/spellbook` (`monorepo/packages/spellbook/src/spellbook.ts`) rewritten on
 * Effect Schema — hand-written here, importing nothing from it: params and result are Effect
 * `Schema` values instead of Standard Schema, and `execute` returns an Effect instead of a Promise,
 * so a spell's failures and service needs ride its own type.
 */

import {type Effect, Schema} from "effect";
import type {ProcessId} from "../process/process.ts";
import type {CapabilityRequest} from "../registry/program.ts";

// Type-only brands: plain strings at runtime, distinct types to the checker, like `ProgramId`.
export const WindowId = Schema.String.pipe(Schema.brand("tuval/WindowId"));
export type WindowId = typeof WindowId.Type;

export const WorkspaceId = Schema.String.pipe(Schema.brand("tuval/WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const ClientId = Schema.String.pipe(Schema.brand("tuval/ClientId"));
export type ClientId = typeof ClientId.Type;

/**
 * Where a call came from. A workspace and a client are always known; a window and a process are
 * known only when the caller was inside one. The executor child resolves a Scope and hands it to
 * `execute`; this slice only types it.
 */
export interface Scope {
	readonly window?: WindowId;
	readonly process?: ProcessId;
	readonly workspace: WorkspaceId;
	readonly client: ClientId;
}

/**
 * A spell's address: a non-empty list of segments, lowercase English words (`["window", "close"]`).
 * Non-emptiness is in the type, so an empty path is unrepresentable rather than refused.
 */
export type SpellPath = readonly [string, ...ReadonlyArray<string>];

/** The address as a refusal and a description render it: `window.close`. */
export const renderPath = (path: SpellPath): string => path.join(".");

export interface Spell<Params extends Schema.Top, Result extends Schema.Top, E, R> {
	readonly path: SpellPath;
	/** One user-facing sentence. It is what a client shows beside the path. */
	readonly describe: string;
	readonly params: Params;
	readonly result: Result;
	readonly execute: (args: Params["Type"], scope: Scope) => Effect.Effect<Result["Type"], E, R>;
	/**
	 * DECLARED AND CHECKED BY NOTHING (#7617 R1.6). Reusing the kernel's inert `CapabilityRequest`
	 * record, this list is stored, described and enforced by no one — local code is fully trusted
	 * and there is no sandbox. It is not a security boundary and must not be read as one.
	 */
	readonly capabilities: ReadonlyArray<CapabilityRequest>;
}

/**
 * Pins a spell's parameter, result, error and requirement types at the definition site. It is the
 * identity function: the whole job is inference, so an `execute` that returns a Promise or a
 * `params` that is not an Effect `Schema` is a compile error where it is written.
 */
export const defineSpell = <Params extends Schema.Top, Result extends Schema.Top, E, R>(
	spell: Spell<Params, Result, E, R>,
): Spell<Params, Result, E, R> => spell;

/**
 * A spell with its private types erased: what the registry stores, since one registry holds spells
 * of every shape. The executor recovers the concrete types when it runs one.
 */
export type AnySpell = Spell<any, any, any, any>;
