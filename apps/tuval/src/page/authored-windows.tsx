/**
 * The half of an authored `window` that has to be React: the page-side adapter that turns what
 * `defineProgram` compiled into an entry the page's renderer table can hold.
 *
 * The two halves do not meet on their own. `compileWindow` answers a renderer whose `render` is
 * `(host) => (state) => Out` (`../authoring/view.ts`): the authoring layer sits on the kernel's
 * React-free lens and a `WindowHost` publishes state as a stream with no synchronous read
 * (`../shell/window/host.ts`), so it binds `send` to the host and leaves the author's view as a
 * function of state for whoever mounts it. The page's table wants a `ReadableRenderer`, whose
 * `render` answers a `ReactNode`. This module is the one place that subscribes on the author's
 * behalf and calls their function per state — the same subscription `ReadableWindow` does, from
 * the module they now share.
 *
 * Without it an authored row declares a reference the page answers with `unknown-ref`, and the
 * author sees the unresolved-reference placeholder where their window should be.
 */

import type {ReactElement, ReactNode} from "react";
import {authoredWindowRenderers} from "../authoring/view.ts";
import type {AnyWindowHost, AnyWindowRenderer} from "../shell/window/index.ts";
import {windowRenderer} from "../shell/window/index.ts";
import {Pending, type ReadableRenderer, readsState, useProcessState} from "./readable-state.tsx";

/**
 * What an authored window is admitted on, and it is everything.
 *
 * The predicate belongs to the program whose state it is
 * (`.patterns/window-renderer-admission.md`), and an authored program declares none: `window` alone
 * has to draw a window, so the default cannot refuse. The drift protection #8157 bought is
 * therefore weaker for an authored window than for a hand-seated one — the cost is bounded by that
 * pattern's second invariant, the per-window `ErrorBoundary` in `../shell/ui/WindowView.tsx`, so an
 * authored window reading a state a stale kernel still sends costs that one window and not the
 * desk.
 *
 * It is a named predicate rather than an inline `() => true` so the weaker guarantee is visible in
 * the table, and so there is one seat for a declared predicate to land in if the authoring API ever
 * grows a way to write one.
 */
const admitsAnyState = (_state: unknown): _state is unknown => true;

function AuthoredWindow({
	host,
	view,
}: {
	readonly host: AnyWindowHost;
	readonly view: (state: unknown) => ReactNode;
}): ReactElement {
	const state = useProcessState(host);
	// `null` is "no view has arrived", not a state the author's function should be called on: it
	// reads `state.x` and a fresh window has nothing to read yet.
	if (state === null) return <Pending />;
	return <>{view(state)}</>;
}

/**
 * One compiled authored renderer as a table entry. The `Out` the author's function answers is
 * unconstrained in `../authoring/view.ts` — a plain record in a test, a React node on this surface
 * — and this module is the surface, so reading it as a `ReactNode` is the cast that belongs here
 * and nowhere else. Nothing is cast around the brand: the entry is minted by `readsState` like
 * every other.
 */
const authoredEntry = (renderer: AnyWindowRenderer): ReadableRenderer =>
	readsState(
		admitsAnyState,
		windowRenderer(renderer.kind, (host: AnyWindowHost) => (
			<AuthoredWindow host={host} view={renderer.render(host) as (state: unknown) => ReactNode} />
		)),
	);

/**
 * Every window `defineProgram` has compiled, as table entries under the references the rows name.
 *
 * It is read at call time rather than held as a constant, which is what makes a hot reload land:
 * re-compiling a program replaces its one seat in the authoring layer's map, and the next table
 * built here carries the replacement. A program declaring no `window` seats nothing and has no
 * entry, which is how a headless program stays one.
 */
export const authoredPageRenderers = (): Readonly<Record<string, ReadableRenderer>> =>
	Object.fromEntries(
		Object.entries(authoredWindowRenderers()).map(([ref, renderer]) => [
			ref,
			authoredEntry(renderer),
		]),
	);
