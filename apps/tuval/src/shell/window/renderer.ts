/**
 * What a program row's optional renderer reference (#7511) resolves to. A `RendererRef` on the row
 * is a nominal kind plus a name; this slice says the one shape that name has to name — a function of
 * one `WindowHost` — and how a shell turns the reference into it. `Out` is the renderer's own output,
 * a React element on the browser surface and a plain record in a test, so nothing here names React.
 *
 * The lineage this replaces is `monorepo/services/usir-in/studio/widget.tsx`: a module-level object
 * of six hard-coded widget names, each mapping to a component plus a Zustand hook, whose
 * `useWidgetStore` threw on an unknown name. Here the table is per-shell data, the entry is the
 * program's own, and an unresolved reference is a returned value.
 */

import type {Message} from "../../process/process.ts";
import type {AnyProgram, RendererKind, RendererRef} from "../../registry/program.ts";
import type {ViewState, WindowHost} from "./host.ts";

export interface WindowRenderer<
	Out = unknown,
	S = unknown,
	M extends Message = Message,
	V extends ViewState = ViewState,
> {
	readonly kind: RendererKind;
	readonly render: (host: WindowHost<S, M, V>) => Out;
}

/** A renderer with its program's types erased: what a shell-wide table holds, as `AnyProgram` is to `Program`. */
export type AnyWindowRenderer = WindowRenderer<any, any, any, any>;

/**
 * Mint a renderer with its host shape inferred from the function. A program author writes
 * `windowRenderer("host-native", (host) => …)` and the checker fixes `S`, `M` and `V` from the
 * annotated parameter, so a renderer written against another program's host is a compile error where
 * that program's renderer type is required.
 */
export const windowRenderer = <Out, S, M extends Message, V extends ViewState>(
	kind: RendererKind,
	render: (host: WindowHost<S, M, V>) => Out,
): WindowRenderer<Out, S, M, V> => ({kind, render});

/** Why a reference did not resolve. Both arms are the shell's own answer, never a throw. */
export type RendererRefusal = "unknown-ref" | "kind-mismatch";

export type RendererResolution =
	| {readonly _tag: "Resolved"; readonly renderer: AnyWindowRenderer}
	/** The program row declares no renderer: it runs, and it never shows in a window. */
	| {readonly _tag: "NoRenderer"}
	| {
			readonly _tag: "RendererUnresolved";
			readonly ref: RendererRef;
			readonly reason: RendererRefusal;
	  };

/** How a shell turns a row's reference into the renderer it names. The transport picks the implementation. */
export type RendererResolver = (ref: RendererRef) => RendererResolution;

/**
 * The resolver over a table keyed by `RendererRef.ref`. `kind` is checked too: a reference asking
 * for an `isolated-frame` renderer must not be answered with the `host-native` one of the same name.
 */
export const resolverFromTable =
	(table: Readonly<Record<string, AnyWindowRenderer>>): RendererResolver =>
	(ref) => {
		const renderer = table[ref.ref];
		if (renderer === undefined) return {_tag: "RendererUnresolved", ref, reason: "unknown-ref"};
		if (renderer.kind !== ref.kind) {
			return {_tag: "RendererUnresolved", ref, reason: "kind-mismatch"};
		}
		return {_tag: "Resolved", renderer};
	};

/** The row's renderer, or the reason there is none. This is the only route from a program to its window renderer. */
export const rendererFor = (row: AnyProgram, resolve: RendererResolver): RendererResolution =>
	row.renderer === undefined ? {_tag: "NoRenderer"} : resolve(row.renderer);
