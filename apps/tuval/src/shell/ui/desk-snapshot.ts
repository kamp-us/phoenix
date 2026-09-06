/**
 * The `DeskSnapshot` the desk regions are composed from, assembled where the live half of it lives.
 *
 * `../desk/` is pure and imports no React and nothing from here
 * ([`.patterns/tuval-shell-assembly.md`](../../../../../.patterns/tuval-shell-assembly.md)), so it
 * states what a snapshot *is* and never builds one: half of it — the `WindowHost` a renderer mounts
 * into, and the two renderer tables a page assembles from its own imports — exists only on the
 * surface. This module is that assembly and nothing else.
 *
 * The host comes back through the same `MountResolver` the tiling area already asks per window, so
 * the inspector cannot mount a host the windows do not also hold; a second lookup here would be a
 * second answer to "what is this window showing".
 */

import {ProcessId} from "../../process/process.ts";
import type {ShellState} from "../core/index.ts";
import {activeWorkspace, processOf} from "../core/index.ts";
import type {
	AnyInspectorRenderer,
	AnyStatusRenderer,
	DeclaredRenderers,
	DeskSnapshot,
	KernelFacts,
	SnapshotProcess,
} from "../desk/index.ts";
import {WindowId} from "../window/index.ts";
import type {MountResolver} from "./mount.ts";

/**
 * The half of a snapshot the shell state does not carry: what the socket said about the kernel and
 * its processes, and the renderers this page answers a program's references with.
 */
export interface DeskTables {
	readonly kernel: KernelFacts;
	/** Keyed by process id, as the snapshot reads it. */
	readonly processes: Readonly<Record<string, SnapshotProcess>>;
	/** Keyed by `ProgramId`: the two desk references each program row declares. */
	readonly programs: Readonly<Record<string, DeclaredRenderers>>;
	/** Both keyed by `RendererRef.ref`, as the window renderer table is. */
	readonly inspectors: Readonly<Record<string, AnyInspectorRenderer>>;
	readonly statuses: Readonly<Record<string, AnyStatusRenderer>>;
}

/**
 * A page that has attached to nothing yet, and what a caller supplying no tables gets. A whole
 * snapshot's worth of empty rather than an absence, so every region still composes: the inspector
 * answers with a reason and the bar still carries its shell-owned left and right.
 */
export const noDeskTables: DeskTables = {
	kernel: {processes: 0, revision: 0},
	processes: {},
	programs: {},
	inspectors: {},
	statuses: {},
};

export const deskSnapshotOf = (
	state: ShellState,
	tables: DeskTables,
	resolveMount: MountResolver,
): DeskSnapshot => {
	const workspace = activeWorkspace(state);
	const focused = workspace?.focused ?? null;
	const processId =
		workspace === undefined || focused === null ? null : processOf(workspace, focused);
	const mount = focused === null ? null : resolveMount(WindowId.make(focused), processId);
	return {
		workspace: state.activeWorkspace,
		kernel: tables.kernel,
		focused:
			focused === null
				? null
				: {
						windowId: WindowId.make(focused),
						processId: processId === null ? null : ProcessId.make(processId),
						host: mount !== null && mount._tag === "Bound" ? mount.host : null,
					},
		processes: tables.processes,
		programs: tables.programs,
		inspectors: tables.inspectors,
		statuses: tables.statuses,
	};
};
