/**
 * The desk: the whole browser surface for one shell process. It renders the active workspace's
 * layout, the status line and — when a key asked for it — the command line, and it owns the page's
 * one application-level keyboard listener.
 *
 * "One listener" is the invariant, and it has exactly two sanctioned exceptions, both of them
 * elements that would be broken without their own keys: the command line's `input`, and each
 * `Separator` react-resizable-panels renders (its arrow/Home/End/Enter resize keys are attached per
 * element by the library). Neither dispatches `keys.press`. Nothing else in the app calls
 * `addEventListener("keydown", …)`, and `./boundary.unit.test.ts` scans for it.
 *
 * The desk holds no desk state. Workspaces, layout, focus and view slots come from the snapshot the
 * kernel sent and go back as Msgs; what lives here is tab-ephemeral and nothing else — whether the
 * command line is open, whether the palette is, and the prefix countdown (#7556).
 *
 * The command line and the palette are two doors onto one command table, never two mechanisms: the
 * `<prefix> :` line is the address you already know, `⌘K` the one you go looking through, and both
 * end at the rows in `../commands/table.ts` (#7643, `./PaletteHost.tsx`).
 */

import type {ReactElement, ReactNode} from "react";
import {useCallback, useEffect, useRef, useState} from "react";
import {usePalette} from "../../palette/index.ts";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {activeWorkspace, processOf} from "../core/index.ts";
import {defaultPrefixTable, type Key, type PrefixTable} from "../keys/index.ts";
import type {PickerEntries} from "../picker/browser.ts";
import {noEntries} from "../picker/browser.ts";
import {WindowId} from "../window/index.ts";
import {CommandLine} from "./CommandLine.tsx";
import {type ForwardedKey, ForwardedKeyProvider} from "./forwarded-key.tsx";
import {routerPrefix, statusFrame, surfaceKey, zoomedWindow} from "./frame.ts";
import {LayoutView} from "./LayoutView.tsx";
import type {MountResolver} from "./mount.ts";
import {focusedWindowOf, PaletteHost} from "./PaletteHost.tsx";
import {StatusLine} from "./StatusLine.tsx";
import {isTextEntry} from "./text-entry.ts";
import {WindowView} from "./WindowView.tsx";

export interface DeskProps {
	readonly state: ShellState;
	readonly dispatch: (msg: ShellMsg) => void;
	readonly resolveMount: MountResolver;
	readonly entries?: PickerEntries;
	/** The grammar both the core and this surface route against. One table, or the two disagree. */
	readonly table?: PrefixTable;
	/** The listener's home. `document` in a page; a container in a test that wants two desks. */
	readonly keyTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
	readonly reducedMotion?: boolean;
}

export function Desk({
	state,
	dispatch,
	resolveMount,
	entries = noEntries,
	table = defaultPrefixTable,
	keyTarget,
	reducedMotion = false,
}: DeskProps): ReactElement {
	const [commandLineOpen, setCommandLineOpen] = useState(false);
	const [forwarded, setForwarded] = useState<ForwardedKey | null>(null);
	const seq = useRef(0);
	const desk = useRef<HTMLDivElement>(null);

	const workspace = activeWorkspace(state);
	const focused = workspace?.focused ?? null;

	const palette = usePalette();

	// Read through a ref so the listener is attached once per target and never re-attached on a
	// snapshot: a re-attach between two presses of one sequence would drop the second.
	const latest = useRef({state, table, focused, commandLineOpen, dispatch, palette});
	latest.current = {state, table, focused, commandLineOpen, dispatch, palette};

	const onKeyDown = useCallback((event: KeyboardEvent): void => {
		const {state: current, table: grammar, focused: window, commandLineOpen: open} = latest.current;
		const overlay = latest.current.palette;
		if (open || overlay.open || isTextEntry(event.target)) return;

		// The palette's own door, beside the `<prefix> :` line rather than instead of it: one is the
		// address you already know, the other is the one you go looking through (#7643).
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			overlay.openPalette(focusedWindowOf(latest.current.state));
			return;
		}

		const key: Key = {
			key: event.key,
			code: event.code,
			shiftKey: event.shiftKey,
			ctrlKey: event.ctrlKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
		};
		const answer = surfaceKey(grammar, routerPrefix(current), key);
		// The kernel owns the desk, so every press goes to it whatever the surface also does with it.
		latest.current.dispatch({type: "keys.press", key});

		switch (answer._tag) {
			case "OpenCommandLine":
				event.preventDefault();
				setCommandLineOpen(true);
				return;
			case "ToWindow":
				if (window === null) return;
				seq.current += 1;
				setForwarded({windowId: WindowId.make(window), key: answer.key, seq: seq.current});
				return;
			case "Shell":
				// A bound sequence is the shell's; swallowing it is what stops `prefix |` from typing
				// a pipe into whatever had focus.
				if (answer.command !== null) event.preventDefault();
				return;
		}
	}, []);

	useEffect(() => {
		const target = keyTarget === undefined ? globalThis.document : keyTarget;
		if (target === null || target === undefined) return;
		target.addEventListener("keydown", onKeyDown as EventListener);
		return () => target.removeEventListener("keydown", onKeyDown as EventListener);
	}, [keyTarget, onKeyDown]);

	// The core's prefix timer is a Cmd, and Cmds do not cross the transport — but the snapshot
	// carries the window's length, so the surface runs the countdown off state alone.
	//
	// The dependency is the prefix's *value*, spelled out, and never the `state.prefix` object: every
	// snapshot arrives JSON-decoded, so that object is new on each one and an effect keyed on it
	// re-armed the countdown on unrelated kernel traffic — a demo counter ticking once a second
	// starved an armed prefix indefinitely (#7782).
	const armed = state.prefix.armed;
	const timeoutMs = state.prefix.armed ? state.prefix.timeoutMs : 0;
	const pending = state.prefix.armed ? state.prefix.pending.join("") : "";
	useEffect(() => {
		if (!armed) return;
		// Through the ref, so the caller's `dispatch` identity is not a dependency either — the same
		// starvation, from the other direction.
		const timer = setTimeout(() => latest.current.dispatch({type: "prefix.timeout"}), timeoutMs);
		return () => clearTimeout(timer);
		// `pending` is a dependency because each key typed into an armed sequence restarts the window,
		// exactly as `startPrefixTimer` restarts the host's one timer.
	}, [armed, timeoutMs, pending]);

	const closeCommandLine = useCallback(() => {
		setCommandLineOpen(false);
		desk.current?.focus();
	}, []);

	const closePalette = useCallback(() => {
		palette.closePalette();
		// The hook hands the caret back to whatever held it. `document.body` is what holds it on a
		// desk nobody has clicked yet, and it cannot take focus, so the desk takes it instead.
		if (globalThis.document.activeElement === globalThis.document.body) desk.current?.focus();
	}, [palette]);

	const renderWindow = (windowId: WindowId): ReactNode => (
		<WindowView
			key={windowId}
			windowId={windowId}
			mount={resolveMount(
				windowId,
				workspace === undefined ? null : processOf(workspace, windowId),
			)}
			focused={focused === windowId}
			view={state.views[windowId]}
			entries={entries}
			dispatch={dispatch}
			reducedMotion={reducedMotion}
		/>
	);

	return (
		<div className="tuval-surface" ref={desk} tabIndex={-1} data-scheme="dark">
			<ForwardedKeyProvider value={forwarded}>
				{workspace === undefined ? (
					<div className="tuval-tiling tuval-placeholder" role="status">
						<p>This desk has no active workspace. Open one with the command line.</p>
					</div>
				) : (
					<LayoutView
						root={workspace.layout.root}
						zoomed={zoomedWindow(workspace)}
						renderWindow={renderWindow}
						dispatch={dispatch}
					/>
				)}
			</ForwardedKeyProvider>
			{commandLineOpen ? <CommandLine dispatch={dispatch} onClose={closeCommandLine} /> : null}
			{palette.open ? (
				<PaletteHost
					state={state}
					dispatch={dispatch}
					window={palette.window}
					onClose={closePalette}
				/>
			) : null}
			<StatusLine frame={statusFrame(state)} prefixKey={table.prefix} />
		</div>
	);
}
