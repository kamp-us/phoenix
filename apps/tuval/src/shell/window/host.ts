/**
 * The window contract: the one seam a program's renderer mounts into (#7484 R1.1, the Vim buffer
 * model). A `WindowHost` is everything a renderer gets — its window, its process, a subscription to
 * that process's public state, a way to send a Msg into it, and a view slot the window owns. It is
 * transport-blind on purpose: a renderer sees a read and a dispatch, never a socket, so one type
 * serves the in-process test double here and the WebSocket transport the page attaches over.
 *
 * This replaces `monorepo/services/usir-in/studio/widget.tsx`, a closed table of six widget names
 * mapping to a component and a Zustand store, where an unknown name threw. Nothing here is closed
 * and nothing here throws: a program brings its own renderer, and both fallbacks are data.
 */

import type {Effect, Schema, Stream} from "effect";
import {Schema as S} from "effect";
import type {Lifecycle, Message, ProcessId} from "../../process/process.ts";

// Type-only brand: a plain string at runtime, a distinct type to the checker (`.patterns/effect-schema-validation.md`).
export const WindowId = S.String.pipe(S.brand("tuval/WindowId"));
export type WindowId = typeof WindowId.Type;

/**
 * What may live in a window's view slot: `effect/Schema`'s own immutable JSON type at the pin
 * (rc.112 — `null | number | boolean | string | JsonArray | JsonObject`). The slot is JSON because
 * the shell checkpoints it through the kernel like the rest of its state, so a function, a DOM node
 * or an Effect value must not be able to enter it.
 */
export type ViewState = Schema.Json;

/** The process is live. Mirrors the kernel's `StateSummary` with `state` typed at the program's own shape. */
export interface ProcessLive<S> {
	readonly _tag: "Live";
	readonly processId: ProcessId;
	readonly lifecycle: Lifecycle;
	/** Committed transitions since spawn. Moves on every commit and says nothing about the state's shape. */
	readonly revision: number;
	readonly state: S;
}

/** The window's process id no longer resolves. A value, never a thrown error: the surface renders the placeholder. */
export interface ProcessGone {
	readonly _tag: "ProcessGone";
	readonly processId: ProcessId;
}

/** No process is bound to the window. A value, never a thrown error: the surface renders the program picker. */
export interface Empty {
	readonly _tag: "Empty";
}

/** What a `readProcess` subscription emits. `ProcessGone` is terminal for that process id. */
export type ProcessView<S> = ProcessLive<S> | ProcessGone;

/** The Msg reached the process. Whether its handlers then succeeded is read back through `readProcess`. */
export interface Delivered {
	readonly _tag: "Delivered";
}

/**
 * A dispatch is fire-and-acknowledge: the host answers that the Msg reached a live process, or that
 * the process is gone, and nothing else. A handler failure is not a window's error — it moves the
 * process's state or the kernel's log, and the renderer reads it back through `readProcess`.
 */
export type DispatchResult = Delivered | ProcessGone;

export const delivered: Delivered = {_tag: "Delivered"};
export const empty: Empty = {_tag: "Empty"};
export const processGone = (processId: ProcessId): ProcessGone => ({
	_tag: "ProcessGone",
	processId,
});

export const isProcessGone = (value: {readonly _tag: string}): value is ProcessGone =>
	value._tag === "ProcessGone";

export const isEmpty = (value: {readonly _tag: string}): value is Empty => value._tag === "Empty";

/**
 * What a renderer receives. `S`, `M` and `V` are the program's own state, Msg and view record; a
 * host held by the shell beside windows of every other program erases them, and the program's own
 * module recovers them.
 */
export interface WindowHost<
	S = unknown,
	M extends Message = Message,
	V extends ViewState = ViewState,
> {
	readonly windowId: WindowId;
	readonly processId: ProcessId;
	/**
	 * The process's public state: the current value first, then every subsequent change, ending on
	 * `ProcessGone` if the process leaves the table. Never fails — both fallbacks are values.
	 */
	readonly readProcess: Stream.Stream<ProcessView<S>>;
	readonly dispatch: (msg: M) => Effect.Effect<DispatchResult>;
	/** The window's own view slot, read live. Two windows over one process own two slots. */
	readonly view: () => V;
	readonly setView: (next: V) => Effect.Effect<void>;
}

/** A host with its program's types erased: what the shell stores while it holds windows of every program. */
export type AnyWindowHost = WindowHost<any, any, any>;

/**
 * What one window is showing. The three arms are the whole vocabulary: a bound host the renderer
 * mounts into, the placeholder, and the picker. There is no fourth arm and no exception.
 */
export type WindowSlot<S = unknown, M extends Message = Message, V extends ViewState = ViewState> =
	| {readonly _tag: "Bound"; readonly host: WindowHost<S, M, V>}
	| ProcessGone
	| Empty;

export const bound = <S, M extends Message, V extends ViewState>(
	host: WindowHost<S, M, V>,
): WindowSlot<S, M, V> => ({_tag: "Bound", host});
