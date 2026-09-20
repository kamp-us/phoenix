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

/**
 * Why a reference did not resolve. Every arm is the shell's own answer, never a throw.
 * `module-load-failed` is the arm a `kind: "module"` reference lands on when the page loaded its
 * specifier and got no renderer back (ADR 0359); `detail` on the resolution says what it got.
 */
export type RendererRefusal = "unknown-ref" | "kind-mismatch" | "module-load-failed";

export type RendererResolution =
	| {readonly _tag: "Resolved"; readonly renderer: AnyWindowRenderer}
	/** The program row declares no renderer: it runs, and it never shows in a window. */
	| {readonly _tag: "NoRenderer"}
	| {
			readonly _tag: "RendererUnresolved";
			readonly ref: RendererRef;
			readonly reason: RendererRefusal;
			/** For `module-load-failed`: the load's own sentence, so the placeholder can name it. */
			readonly detail?: string;
	  };

/** How a shell turns a row's reference into the renderer it names. The transport picks the implementation. */
export type RendererResolver = (ref: RendererRef) => RendererResolution;

/**
 * What a table holds for a reference whose module the page tried to load and could not: the failure
 * itself, as a value in the renderer's seat. It stays in the table rather than being dropped so the
 * resolver can tell "no module was ever named for this" from "it was named and did not load" — the
 * second is the one a founder can act on, and it must not read as the first.
 */
export interface RendererLoadFailure {
	readonly _tag: "RendererLoadFailure";
	readonly detail: string;
}

export const rendererLoadFailure = (detail: string): RendererLoadFailure => ({
	_tag: "RendererLoadFailure",
	detail,
});

const isLoadFailure = (
	entry: AnyWindowRenderer | RendererLoadFailure,
): entry is RendererLoadFailure => "_tag" in entry && entry._tag === "RendererLoadFailure";

/** A shell-wide renderer table, keyed by `RendererRef.ref`. */
export type RendererTable = Readonly<Record<string, AnyWindowRenderer | RendererLoadFailure>>;

/**
 * The resolver over a table keyed by `RendererRef.ref`. `kind` is checked too: a reference asking
 * for an `isolated-frame` renderer must not be answered with the `host-native` one of the same name.
 */
export const resolverFromTable =
	(table: RendererTable): RendererResolver =>
	(ref) => {
		const entry = table[ref.ref];
		if (entry === undefined) return {_tag: "RendererUnresolved", ref, reason: "unknown-ref"};
		if (isLoadFailure(entry)) {
			return {_tag: "RendererUnresolved", ref, reason: "module-load-failed", detail: entry.detail};
		}
		if (entry.kind !== ref.kind) {
			return {_tag: "RendererUnresolved", ref, reason: "kind-mismatch"};
		}
		return {_tag: "Resolved", renderer: entry};
	};

/**
 * A program row beside the config module that declared it. Node resolved the row's own imports from
 * that module, and a `kind: "module"` renderer on the row is the other half of the same program, so
 * that module is the base its specifier resolves from too — a program installed beside the user's
 * config is whole there, and never has to be a dependency of the app (#8262).
 */
export interface DeclaredProgram {
	readonly row: AnyProgram;
	/** Absolute path of the config module whose `programs` array holds this row. */
	readonly origin: string;
}

/** One `kind: "module"` window specifier, carrying the config module that declared its row. */
export interface ModuleRendererRef {
	/** The specifier as the row wrote it: the key the page seats the loaded renderer under. */
	readonly ref: string;
	/** Absolute path of the config module that declared the row — what `ref` resolves from. */
	readonly origin: string;
}

/**
 * The module specifiers a set of declared rows asks the page to load: one per `kind: "module"`
 * window reference, in row order, each once. The page server generates its loader module from
 * exactly this list, which is why it is computed here from the rows and not typed twice.
 *
 * The dedupe key is `ref` alone, because that string is the renderer table's key and two seats
 * cannot share one. Where two rows wrote the same specifier, the first keeps its origin: a merged
 * row sits in the layer position it overrode, so a project row replacing a global one by id already
 * arrives here carrying the project config as its origin.
 */
export const moduleRendererRefs = (
	declared: ReadonlyArray<DeclaredProgram>,
): ReadonlyArray<ModuleRendererRef> => {
	const seen = new Map<string, ModuleRendererRef>();
	for (const {row, origin} of declared) {
		if (row.renderer?.kind !== "module") continue;
		if (seen.has(row.renderer.ref)) continue;
		seen.set(row.renderer.ref, {ref: row.renderer.ref, origin});
	}
	return [...seen.values()];
};

/** The row's renderer, or the reason there is none. This is the only route from a program to its window renderer. */
export const rendererFor = (row: AnyProgram, resolve: RendererResolver): RendererResolution =>
	row.renderer === undefined ? {_tag: "NoRenderer"} : resolve(row.renderer);
