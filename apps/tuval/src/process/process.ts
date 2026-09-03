/**
 * A process is one running instance of a program (#7484 R1.1; the operating-system kind is always
 * "OS process"). Its program's private types are erased at the registry row, so a handle speaks
 * `{type: string}` messages and `unknown` state; the program's own module knows the real shapes.
 */

import {type Effect, type Option, Schema, type Scope} from "effect";
import type {DispatchError} from "../host/actor.ts";
import type {PortSchema, ProgramId} from "../registry/program.ts";
import type {HandlerFailed} from "./errors.ts";

export const ProcessId = Schema.String.pipe(Schema.brand("tuval/ProcessId"));
export type ProcessId = typeof ProcessId.Type;

/** A program's Msg with its shape erased: the tag, plus whatever payload the program's own type carries. */
export interface Message {
	readonly type: string;
	readonly [field: string]: unknown;
}

/** `stopping` is the drain between a stop request and the row leaving the table. */
export type Lifecycle = "running" | "stopping";

export interface StateSummary {
	readonly lifecycle: Lifecycle;
	/** Committed transitions since spawn. Moves on every commit and says nothing about the state's shape. */
	readonly revision: number;
	/** The machine's current state — plain data by Demlik's invariant 1, never an Effect value. */
	readonly state: unknown;
}

/** One change to the table: a row arrived, left, or its state summary moved. `row` reads live. */
export interface ProcessChange {
	readonly kind: "spawned" | "stopped" | "state-changed";
	readonly row: ProcessRow;
}

/** One live row of the `ProcessTable`. `stateSummary` reads live; everything else is fixed at spawn. */
export interface ProcessRow {
	readonly id: ProcessId;
	readonly programId: ProgramId;
	readonly parentId: Option.Option<ProcessId>;
	readonly ports: Readonly<Record<string, PortSchema>>;
	readonly stateSummary: () => StateSummary;
}

export interface ProcessHandle {
	readonly id: ProcessId;
	readonly programId: ProgramId;
	readonly parentId: Option.Option<ProcessId>;
	/**
	 * The process's own Scope, a child of its parent's. A slice that must run work for exactly as
	 * long as the process lives (durability's store, a port's subscription) adds a finalizer here.
	 */
	readonly scope: Scope.Scope;
	/** Apply `msg`, then wait for every transitive follow-up. Refused loudly once the process stopped. */
	readonly dispatch: (msg: Message) => Effect.Effect<void, DispatchError<HandlerFailed>>;
	readonly getState: () => unknown;
	/** Close the scope: descendants first, then the actor's drain, Sub disposers and finalizers. Idempotent. */
	readonly stop: Effect.Effect<void>;
}
