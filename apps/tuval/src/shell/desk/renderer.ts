/**
 * The two desk-level renderers a program declares beside its window renderer (#7500, rulings 4 and
 * 5): the inspector that fills the region beside the tiling area, and the status renderer that
 * fills the middle of the status bar. A program never draws outside its own window, so neither of
 * these is a surface the program owns — the program hands the shell a renderer, and the shell
 * decides where and whether it runs.
 *
 * Both take the same `WindowHost` the window renderer takes (`../window/host.ts`), so both are
 * transport-blind for the same reason and both read that program's selection state out of the one
 * process the focused window shows.
 *
 * The two differ in exactly one way, and it is ruling 5: an inspector renders whatever its surface
 * renders, so its output is a free `Out` like the window renderer's; a status renderer returns
 * **segments**, a fixed data shape, because the bar is not the program's to draw. That is what makes
 * "the shell owns the left and the right" a type rather than a convention.
 */

import type {Message} from "../../process/process.ts";
import type {RendererKind} from "../../registry/program.ts";
import type {ViewState, WindowHost} from "../window/host.ts";

/**
 * The shape a program's optional `inspector` reference resolves to. `Out` is the renderer's own
 * output — a React element on the browser surface, a plain record in a test — so nothing here names
 * React, exactly as `WindowRenderer` does not.
 */
export interface InspectorRenderer<
	Out = unknown,
	S = unknown,
	M extends Message = Message,
	V extends ViewState = ViewState,
> {
	readonly kind: RendererKind;
	readonly render: (host: WindowHost<S, M, V>) => Out;
}

/** An inspector renderer with its program's types erased: what a shell-wide table holds. */
export type AnyInspectorRenderer = InspectorRenderer<any, any, any, any>;

/**
 * One piece of the status bar. JSON, because a segment crosses the same wire the desk's state does
 * and a surface binds it verbatim; `tone` is a name a surface styles, never a colour, so a segment
 * cannot carry presentation.
 */
export interface StatusSegment {
	/** Stable within one bar, so a surface can key a list on it. */
	readonly id: string;
	readonly text: string;
	readonly tone?: "normal" | "attention";
}

/**
 * The shape a program's optional `status` reference resolves to. It returns segments and nothing
 * else: there is no region field on a segment and no whole-bar return type, so a program has no
 * vocabulary in which to ask for the left or the right (#7500 ruling 5).
 */
export interface StatusRenderer<
	S = unknown,
	M extends Message = Message,
	V extends ViewState = ViewState,
> {
	readonly kind: RendererKind;
	readonly segments: (host: WindowHost<S, M, V>) => ReadonlyArray<StatusSegment>;
}

/** A status renderer with its program's types erased: what a shell-wide table holds. */
export type AnyStatusRenderer = StatusRenderer<any, any, any>;

/**
 * Mint an inspector renderer with its host shape inferred from the function, as `windowRenderer`
 * does: a renderer written against another program's host is a compile error where that program's
 * renderer is required.
 */
export const inspectorRenderer = <Out, S, M extends Message, V extends ViewState>(
	kind: RendererKind,
	render: (host: WindowHost<S, M, V>) => Out,
): InspectorRenderer<Out, S, M, V> => ({kind, render});

/** The same, for a status renderer. The return type is fixed, so only the host shape is inferred. */
export const statusRenderer = <S, M extends Message, V extends ViewState>(
	kind: RendererKind,
	segments: (host: WindowHost<S, M, V>) => ReadonlyArray<StatusSegment>,
): StatusRenderer<S, M, V> => ({kind, segments});
