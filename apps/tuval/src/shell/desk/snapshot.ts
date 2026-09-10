/**
 * What the composition selectors read. The desk-level surfaces are composed *from* the snapshot and
 * never pushed into (#7500 rulings 4 and 5), so this is the whole input: the focused window and the
 * chain from it to a program row, the two renderer tables a reference resolves against, and the two
 * facts the shell puts on the bar itself.
 *
 * It is written structurally rather than imported from `../../protocol/messages.ts` for the reason
 * that module states about its own neighbours: the wire `Snapshot` carries desk state and process
 * rows, not the live `WindowHost` a renderer mounts into nor the renderer tables a page assembles
 * from its own imports. A shell builds this from both halves; a test builds it by hand
 * (`./fixtures.ts`).
 */

import type {ProcessId} from "../../process/process.ts";
import type {ProgramId, RendererRef} from "../../registry/program.ts";
import type {AnyWindowHost, WindowId} from "../window/host.ts";
import type {RendererRefusal} from "../window/renderer.ts";
import type {AnyInspectorRenderer, AnyStatusRenderer} from "./renderer.ts";

/** The two facts the shell states on the right of the bar. Nothing a program declares reaches them. */
export interface KernelFacts {
	/** How many processes the table holds. */
	readonly processes: number;
	/** The revision the snapshot was taken at. */
	readonly revision: number;
}

/**
 * The focused window, as the selectors need it: which window, which process it shows, and the host
 * a renderer would mount into. `host` is `null` for a window bound to nothing or to a process that
 * has left the table — a value, never a throw, the same call `WindowSlot` makes.
 */
export interface FocusedWindow {
	readonly windowId: WindowId;
	readonly processId: ProcessId | null;
	readonly host: AnyWindowHost | null;
}

/** One process, reduced to the one field the chain to a program row needs. */
export interface SnapshotProcess {
	readonly programId: ProgramId;
}

export interface DeskSnapshot {
	/** The active workspace's name — the segment the shell owns on the left. */
	readonly workspace: string;
	readonly kernel: KernelFacts;
	/** `null` while the desk has no focused window: a value, and the region's empty case. */
	readonly focused: FocusedWindow | null;
	readonly processes: Readonly<Record<string, SnapshotProcess>>;
	/**
	 * The program rows, keyed by `ProgramId`. Typed at the two references the selectors read rather
	 * than at `AnyProgram`, so a real row assigns as it is and a test needs no machine to state one.
	 */
	readonly programs: Readonly<Record<string, DeclaredRenderers>>;
	/** Keyed by `RendererRef.ref`, as the window renderer table is. */
	readonly inspectors: Readonly<Record<string, AnyInspectorRenderer>>;
	readonly statuses: Readonly<Record<string, AnyStatusRenderer>>;
}

/** The two optional references a program row declares beside its window renderer. */
export interface DeclaredRenderers {
	readonly inspector?: RendererRef;
	readonly status?: RendererRef;
}

/**
 * Why a desk region has no program renderer to run. Every arm is a value the shell renders a
 * placeholder for; none of them is an error, and there is no arm for "threw". The last two are the
 * window slice's own `RendererRefusal`, reused rather than restated so a reference that fails to
 * resolve reports the same reason wherever it is resolved.
 */
export type DeskEmptyReason =
	| "no-focused-window"
	/** The focused window shows no process, or its process has left the table. */
	| "window-unbound"
	| "process-unknown"
	| "program-unknown"
	/** The program row is fine and simply declares no renderer for this region. */
	| "not-declared"
	| RendererRefusal;
