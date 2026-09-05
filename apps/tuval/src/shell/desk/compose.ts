/**
 * The composition selectors: pure functions from a `DeskSnapshot` to what the two desk-level
 * regions show. Both walk the same chain — focused window → its process → its program row → the
 * reference that row declares → the renderer that reference names — and both answer with a value
 * on every step that does not resolve, so a desk region is never a hole and never a throw
 * (#7500 rulings 4 and 5).
 *
 * The two answers differ in shape because the ruling makes the surfaces differ. An inspector fills
 * a region the program owns the inside of, so `inspectorFor` hands back the renderer and the host
 * and lets the surface mount them. A status bar is the *shell's*, so `statusFor` runs the program's
 * renderer here and returns a composed bar: the program's segments can only ever arrive in
 * `middle`, because that is the only place this function puts them.
 */

import type {RendererRef} from "../../registry/program.ts";
import type {AnyWindowHost} from "../window/host.ts";
import type {AnyInspectorRenderer, AnyStatusRenderer, StatusSegment} from "./renderer.ts";
import type {DeclaredRenderers, DeskEmptyReason, DeskSnapshot, FocusedWindow} from "./snapshot.ts";

/** A renderer found for the focused window, with the host it mounts into. */
interface Found<R> {
	readonly _tag: "Found";
	readonly renderer: R;
	readonly host: AnyWindowHost;
}

interface Missing {
	readonly _tag: "Missing";
	readonly reason: DeskEmptyReason;
}

/** Which of a row's two references this walk is for. */
type Region = "inspector" | "status";

const missing = (reason: DeskEmptyReason): Missing => ({_tag: "Missing", reason});

/** The program row the focused window's process runs, and the host it mounts into. */
interface Mounted {
	readonly row: DeclaredRenderers;
	readonly host: AnyWindowHost;
}

/**
 * Walk the focused window to the row that declares its renderers. The host rides on the answer so
 * the caller never re-reads `focused.host` after this narrowed it — a row and a host that could
 * disagree about which window they came from is a state that must not be representable.
 */
const mountedRow = (snapshot: DeskSnapshot, focused: FocusedWindow): Mounted | DeskEmptyReason => {
	if (focused.processId === null || focused.host === null) return "window-unbound";
	const process = snapshot.processes[focused.processId];
	if (process === undefined) return "process-unknown";
	const row = snapshot.programs[process.programId];
	return row === undefined ? "program-unknown" : {row, host: focused.host};
};

/**
 * The one walk both selectors share. `table` is keyed by `RendererRef.ref` and the reference's
 * `kind` is checked against the renderer's, as `resolverFromTable` does for the window renderer: a
 * reference asking for an `isolated-frame` renderer must not be answered with the `host-native` one
 * of the same name.
 */
const rendererFor = <R extends {readonly kind: string}>(
	snapshot: DeskSnapshot,
	region: Region,
	table: Readonly<Record<string, R>>,
): Found<R> | Missing => {
	const focused = snapshot.focused;
	if (focused === null) return missing("no-focused-window");
	const mounted = mountedRow(snapshot, focused);
	if (typeof mounted === "string") return missing(mounted);
	const {row, host} = mounted;

	const ref: RendererRef | undefined = region === "inspector" ? row.inspector : row.status;
	if (ref === undefined) return missing("not-declared");
	const renderer = table[ref.ref];
	if (renderer === undefined) return missing("unknown-ref");
	if (renderer.kind !== ref.kind) return missing("kind-mismatch");
	return {_tag: "Found", renderer, host};
};

/**
 * What the inspector region shows: a program's renderer and the host to run it against, or the
 * typed empty case naming which step of the walk ended. The surface renders its placeholder on
 * `NoInspector` and reads nothing else.
 */
export type InspectorRegion =
	| {
			readonly _tag: "Inspector";
			readonly renderer: AnyInspectorRenderer;
			readonly host: AnyWindowHost;
	  }
	| {readonly _tag: "NoInspector"; readonly reason: DeskEmptyReason};

export const inspectorFor = (snapshot: DeskSnapshot): InspectorRegion => {
	const found = rendererFor<AnyInspectorRenderer>(snapshot, "inspector", snapshot.inspectors);
	return found._tag === "Missing"
		? {_tag: "NoInspector", reason: found.reason}
		: {_tag: "Inspector", renderer: found.renderer, host: found.host};
};

/**
 * The status bar, composed. `left` and `right` are derived here from the snapshot's own fields and
 * from nothing else; `middle` is whatever the focused window's program returned, or empty with the
 * reason it is empty.
 */
export interface StatusBar {
	readonly left: ReadonlyArray<StatusSegment>;
	readonly middle: ReadonlyArray<StatusSegment>;
	readonly right: ReadonlyArray<StatusSegment>;
	/** Why the middle is empty, or `null` when a program filled it. */
	readonly middleEmpty: DeskEmptyReason | null;
}

/** The shell's own left: the active workspace, and only that. */
const leftOf = (snapshot: DeskSnapshot): ReadonlyArray<StatusSegment> => [
	{id: "workspace", text: snapshot.workspace},
];

/** The shell's own right: kernel facts, and only those. */
const rightOf = (snapshot: DeskSnapshot): ReadonlyArray<StatusSegment> => [
	{
		id: "processes",
		text: `${snapshot.kernel.processes} process${snapshot.kernel.processes === 1 ? "" : "es"}`,
	},
	{id: "revision", text: `rev ${snapshot.kernel.revision}`},
];

export const statusFor = (snapshot: DeskSnapshot): StatusBar => {
	const found = rendererFor<AnyStatusRenderer>(snapshot, "status", snapshot.statuses);
	const middle = found._tag === "Found" ? found.renderer.segments(found.host) : [];
	return {
		left: leftOf(snapshot),
		middle,
		right: rightOf(snapshot),
		middleEmpty: found._tag === "Found" ? null : found.reason,
	};
};
