/**
 * The `engine-view` registry row: an ordinary program, spawned and windowed like any other.
 *
 * Founder ruling 1 on #7500 settles the shape — `process spawn --program engine-view`, opened,
 * split and closed in a normal window like Pi, never a shell built-in panel. So everything about it
 * is on the row: an id, a core machine, a renderer reference, and nothing a shell has to special-case.
 *
 * The state is one field. The selected process id is a value the machine commits rather than a ref
 * inside the renderer, because the desk inspector reads it back off the process's own state
 * (founder ruling 4); a renderer-local ref would be invisible there. Everything else the view shows
 * is derived from the desk `Snapshot` on every render, so there is no second copy of the graph to
 * drift (founder ruling 2).
 *
 * The row declares no ports and no host handlers: this program reads the process table through the
 * one channel the page already has and never subscribes to `ProcessTablePort` itself.
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import type {ProcessId} from "../../protocol/ids.ts";
import {
	type AnyProgram,
	type Program,
	ProgramId,
	type RendererRef,
} from "../../registry/program.ts";

export const engineViewId = ProgramId.make("engine-view");

/** The name the row's renderer reference resolves under (`src/shell/window/renderer.ts`). */
export const ENGINE_VIEW_RENDERER_REF = "tuval/engine-view";

/** The whole state: which process the view is pointing at, or none. */
export interface EngineViewState {
	readonly selected: ProcessId | null;
}

export type EngineViewMsg =
	| {readonly type: "select"; readonly processId: ProcessId}
	| {readonly type: "clear"}
	/**
	 * The process table changed, carrying every id still in it. A selection naming a process that
	 * has left is cleared here rather than tolerated: the inspector reads this field and would
	 * otherwise be asked to show a process nobody can attach to.
	 */
	| {readonly type: "tableChanged"; readonly present: ReadonlyArray<ProcessId>};

export const engineViewInitial: EngineViewState = {selected: null};

const cleared: EngineViewState = {selected: null};

export const engineViewCore = defineMachine<
	EngineViewState,
	EngineViewMsg,
	Cmd<never>,
	never,
	unknown
>({
	init: (loaded) => [loaded ?? engineViewInitial, []],
	update: {
		select: (state, msg) =>
			state.selected === msg.processId ? [state, []] : [{selected: msg.processId}, []],
		clear: (state) => (state.selected === null ? [state, []] : [cleared, []]),
		tableChanged: (state, msg) => {
			if (state.selected === null) return [state, []];
			return msg.present.includes(state.selected) ? [state, []] : [cleared, []];
		},
	},
});

export const engineViewProgram = (): AnyProgram =>
	({
		id: engineViewId,
		label: "Engine view",
		core: engineViewCore,
		ports: {},
		handlers: {},
		capabilities: [],
		// The page keys its own renderer table by program id — the process-table wire carries no
		// renderer field (`../../page/renderers.tsx`) — but a row with no reference is headless and the
		// picker never offers it (`../../shell/picker/entries.ts`), so the reference is what makes this
		// program windowable at all.
		renderer: {kind: "host-native", ref: ENGINE_VIEW_RENDERER_REF} satisfies RendererRef,
		identity: {
			package: "@kampus/tuval",
			program: "engine-view",
			version: "1.0.0",
			digest: "sha256:engine-view",
		},
		placement: {host: "local"},
	}) satisfies Program<EngineViewState, EngineViewMsg, Cmd<never>, never, unknown, never, never>;
