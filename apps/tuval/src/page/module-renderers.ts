/**
 * The page's half of a `kind: "module"` renderer reference (ADR 0359): given the loaders the page
 * server generated — one `import()` per specifier the rows named — load each, admit what came back,
 * and answer a table the resolver reads beside `./renderers.tsx`.
 *
 * Nothing here throws. A specifier that would not load, or loaded into something that is not a
 * renderer, becomes a `RendererLoadFailure` in that reference's seat, and `resolverFromTable` turns
 * it into `RendererUnresolved` with `module-load-failed` and the sentence — the placeholder in the
 * window then says what happened, which is the whole difference from a blank pane.
 *
 * The loaded renderer goes through `readsState` with the module's own `admits`, so an external
 * window gets the same admission test every in-tree one has (ADR 0358): the rule does not bend for
 * a renderer that arrived by `pnpm add`, and the predicate still belongs to the program whose state
 * it is — the module exports it beside the renderer.
 */

import {Effect, Predicate} from "effect";
import type {ReactNode} from "react";
import type {
	AnyWindowRenderer,
	RendererLoadFailure,
	WindowRenderer,
} from "../shell/window/index.ts";
import {rendererLoadFailure} from "../shell/window/index.ts";
import {type ReadableRenderer, readsState} from "./readable-state.tsx";

/** One thunk per specifier, keyed by the reference string the row wrote: what the virtual module exports. */
export type ModuleLoaders = Readonly<Record<string, () => Promise<unknown>>>;

/** What a renderer module has to export. Checked at load, so a wrong export is a named failure and not a throw in React. */
export interface ModuleRendererExports {
	readonly default: AnyWindowRenderer;
	readonly admits: (state: unknown) => boolean;
}

export type LoadedModuleRenderers = Readonly<
	Record<string, ReadableRenderer | RendererLoadFailure>
>;

const isWindowRenderer = (value: unknown): value is AnyWindowRenderer =>
	Predicate.isObject(value) && typeof value.kind === "string" && typeof value.render === "function";

/** Which of the contract's two exports is missing or malformed, or `null` when both are right. */
const exportsFault = (loaded: unknown): string | null => {
	if (!Predicate.isObject(loaded)) return "the module is not an object";
	if (!isWindowRenderer(loaded.default)) {
		return 'no default export that is a window renderer; export default windowRenderer("module", …)';
	}
	if (loaded.default.kind !== "module") {
		return `the default export is a ${loaded.default.kind} renderer, and a module reference needs one minted with windowRenderer("module", …)`;
	}
	if (typeof loaded.admits !== "function") {
		return "no admits export; export the predicate over the state this renderer reads";
	}
	return null;
};

const thrownMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const loadOne = (
	ref: string,
	load: () => Promise<unknown>,
): Effect.Effect<ReadableRenderer | RendererLoadFailure> =>
	Effect.tryPromise({try: load, catch: (cause) => thrownMessage(cause)}).pipe(
		Effect.map((loaded): ReadableRenderer | RendererLoadFailure => {
			const fault = exportsFault(loaded);
			if (fault !== null) return rendererLoadFailure(`${ref}: ${fault}`);
			const {default: renderer, admits} = loaded as ModuleRendererExports;
			// The one widening: the module's predicate is `(state: unknown) => boolean` because the
			// module is outside the checker's reach, and `readsState` wants a guard. `S` is `unknown`
			// on this side either way — the renderer's own types stayed in its package.
			return readsState(
				admits as (state: unknown) => state is unknown,
				renderer as WindowRenderer<ReactNode, unknown>,
			);
		}),
		Effect.catch((message) =>
			Effect.succeed(rendererLoadFailure(`${ref}: the module threw while loading: ${message}`)),
		),
	);

/** Every loader run, every outcome kept: the table has one seat per reference, resolved or refused. */
export const loadModuleRenderers = (loaders: ModuleLoaders): Effect.Effect<LoadedModuleRenderers> =>
	Effect.forEach(
		Object.entries(loaders),
		([ref, load]) => Effect.map(loadOne(ref, load), (entry) => [ref, entry] as const),
		// Each load is its own import and none reads another's outcome, so they run together.
		{concurrency: "unbounded"},
	).pipe(Effect.map((entries) => Object.fromEntries(entries)));
