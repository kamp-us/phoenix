/**
 * The desk: the whole browser surface for one shell process. It renders the active workspace's
 * layout, the inspector region beside it, the status line and — when a key asked for it — the
 * command line, and it owns the page's one application-level keyboard listener.
 *
 * The two desk-level regions are *composed*, never pushed into: `./desk-snapshot.ts` assembles one
 * `DeskSnapshot` and `../desk/compose.ts` answers what each region shows. Both read that one
 * snapshot, so they cannot disagree about which window is focused.
 *
 * "One listener" is the invariant, and it has exactly two sanctioned exceptions, both of them
 * elements that would be broken without their own keys: the command line's `input`, and each
 * `Separator` react-resizable-panels renders (its arrow/Home/End/Enter resize keys are attached per
 * element by the library). Neither dispatches `keys.press`. Nothing else in the app calls
 * `addEventListener("keydown", …)`, and `./boundary.unit.test.ts` scans for it.
 *
 * The desk holds no desk state. Workspaces, layout, focus and view slots come from the snapshot the
 * kernel sent and go back as Msgs; what lives here is tab-ephemeral and nothing else — whether the
 * command line is open, whether the palette is, the repeat window's countdown (#7556), and the
 * prefix the page advanced past the snapshot (#8274). That last one is the same class as the
 * countdown: it starts from the snapshot, it is derived by the same pure `route` the kernel folds,
 * and it dies with the tab.
 *
 * The command line and the palette are two doors onto one command table, never two mechanisms: the
 * `<prefix> :` line is the address you already know, `⌘K` the one you go looking through, and both
 * end at the rows in `../commands/table.ts` (#7643, `./PaletteHost.tsx`).
 */

import type {ReactElement, ReactNode} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {usePalette} from "../../palette/index.ts";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {activeWorkspace, processOf} from "../core/index.ts";
import {inspectorFor, statusFor} from "../desk/index.ts";
import type {Key, PrefixState, PrefixTable} from "../keys/index.ts";
import {idle} from "../keys/index.ts";
import {layoutSignature} from "../layout/index.ts";
import type {PickerEntries} from "../picker/browser.ts";
import {noEntries} from "../picker/browser.ts";
import {PREFIX_ARMED_ATTRIBUTE, WindowId} from "../window/index.ts";
import {CommandLine} from "./CommandLine.tsx";
import {DeskInspector} from "./DeskInspector.tsx";
import type {DeskTables} from "./desk-snapshot.ts";
import {deskSnapshotOf, noDeskTables} from "./desk-snapshot.ts";
import {ErrorBoundary} from "./ErrorBoundary.tsx";
import {type ForwardedKey, ForwardedKeyProvider} from "./forwarded-key.tsx";
import {
	repeatWindowOf,
	retireAnswered,
	routerPrefix,
	samePrefix,
	shellOwnsKey,
	statusFrame,
	surfaceKey,
	zoomedWindow,
} from "./frame.ts";
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
	/**
	 * The grammar both the core and this surface route against — the table the kernel sent, and no
	 * other. Required: a default here is a page inventing a grammar nobody gave it (ADR 0353).
	 */
	readonly table: PrefixTable;
	/**
	 * The half of a `DeskSnapshot` only the page knows (`./desk-snapshot.ts`): the kernel facts, the
	 * process and program rows, and the two desk renderer tables. Defaulted rather than required, so
	 * a caller that composes no desk regions still renders a desk.
	 */
	readonly deskTables?: DeskTables;
	/** The listener's home. `document` in a page; a container in a test that wants two desks. */
	readonly keyTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
	readonly reducedMotion?: boolean;
}

export function Desk({
	state,
	dispatch,
	resolveMount,
	entries = noEntries,
	table,
	deskTables = noDeskTables,
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

	// The prefix the page routes over: the snapshot's, advanced by the page's own presses since
	// (#8274, `.patterns/tuval-shell-assembly.md`). Held as state as well as in the ref because the
	// countdown below is an effect, and in the ref because the listener reads it without re-attaching.
	const [prefix, setPrefix] = useState<PrefixState>(() => routerPrefix(state));
	const advanced = useRef(prefix);
	// The advances the kernel has not answered yet, oldest first, retired by the effect below.
	const unanswered = useRef<ReadonlyArray<PrefixState>>([]);

	// Closes over refs alone, so the listener holding it is still attached exactly once per target.
	const advancePrefix = useCallback((next: PrefixState): void => {
		// Only a move the kernel will answer with a frame of its own goes on the ledger: a bare
		// modifier press folds to the state it started from and changes nothing on either side.
		if (!samePrefix(next, advanced.current)) unanswered.current = [...unanswered.current, next];
		advanced.current = next;
		setPrefix(next);
	}, []);

	const onKeyDown = useCallback(
		(event: KeyboardEvent): void => {
			const {
				state: current,
				table: grammar,
				focused: window,
				commandLineOpen: open,
			} = latest.current;
			const overlay = latest.current.palette;
			if (open || overlay.open) return;

			// The palette's own door, beside the `<prefix> :` line rather than instead of it: one is the
			// address you already know, the other is the one you go looking through (#7643). It opens
			// from a text entry too — the door you go looking through must not be shut by where the
			// caret happens to be, which is most of the day the composer (#8270).
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				overlay.openPalette(focusedWindowOf(current));
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
			const held = advanced.current;
			const shellOwns = shellOwnsKey(grammar, held, key);
			if (!shellOwns && isTextEntry(event.target)) return;

			const answer = surfaceKey(grammar, held, key);
			// The kernel owns the desk, so every press goes to it whatever the surface also does with it.
			// The raw key and nothing else: the page learns state, it does not send instructions (ADR 0353).
			latest.current.dispatch({type: "keys.press", key});
			advancePrefix(answer.next);
			// Swallowed once, where ownership is decided rather than per arm: the prefix and every key
			// after it are the shell's, so none of them may also insert a character into the text entry
			// underneath — that is what stops `prefix |` typing a pipe into whatever had focus.
			if (shellOwns) event.preventDefault();

			switch (answer._tag) {
				case "OpenCommandLine":
					setCommandLineOpen(true);
					return;
				case "ToWindow":
					if (window === null) return;
					seq.current += 1;
					setForwarded({windowId: WindowId.make(window), key: answer.key, seq: seq.current});
					return;
				case "Shell":
					return;
			}
		},
		[advancePrefix],
	);

	useEffect(() => {
		const target = keyTarget === undefined ? globalThis.document : keyTarget;
		if (target === null || target === undefined) return;
		target.addEventListener("keydown", onKeyDown as EventListener);
		return () => target.removeEventListener("keydown", onKeyDown as EventListener);
	}, [keyTarget, onKeyDown]);

	// The core's repeat timer is a Cmd, and Cmds do not cross the transport — but the snapshot
	// carries the repeat window's length, so the surface runs that one countdown off state alone.
	// An armed prefix carrying no window is not timed at all: it waits indefinitely, as tmux does
	// (#7842), and this effect is the only clock the desk ever ran.
	//
	// It runs off the page-advanced prefix, so the window opens when the repeatable command was
	// pressed rather than one round trip later, which is the half of #8274 the founder felt as a
	// timer.
	//
	// The dependency is the prefix's *value*, spelled out, and never a prefix object: every snapshot
	// arrives JSON-decoded, so that object is new on each one and an effect keyed on it re-armed the
	// countdown on unrelated kernel traffic — a demo counter ticking once a second starved an armed
	// prefix indefinitely (#7782).
	const repeatWindowMs = repeatWindowOf(prefix);
	const pending = prefix._tag === "Armed" ? prefix.pending.join("") : "";
	useEffect(() => {
		if (repeatWindowMs === null) return;
		// Through the ref, so the caller's `dispatch` identity is not a dependency either — the same
		// starvation, from the other direction.
		const timer = setTimeout(() => {
			latest.current.dispatch({type: "prefix.repeatLapsed"});
			// The lapse is the page's own Msg, so the page folds it the way the kernel will.
			advancePrefix(idle);
		}, repeatWindowMs);
		return () => clearTimeout(timer);
		// `pending` is a dependency because each key typed into the window restarts it, exactly as
		// `startRepeatTimer` restarts the host's one timer.
	}, [repeatWindowMs, pending, advancePrefix]);

	// Reconciliation, the other half of holding a prefix on the page. Everything that moves the
	// kernel's prefix is a Msg this page dispatched, so an empty ledger is the one moment the
	// snapshot is at least as new as the page's own — and then the snapshot wins, which is how a
	// kernel-side lapse or a fresh socket puts the page back on the kernel's prefix.
	//
	// Keyed on the snapshot prefix's values for the reason the countdown is: a decoded object is new
	// on every frame, and this must not run on kernel traffic that left the prefix alone. So one run
	// of this effect is one prefix-changing frame, which is what retires one advance.
	const snapshotArmed = state.prefix.armed;
	const snapshotWindowMs = state.prefix.armed ? state.prefix.repeatWindowMs : null;
	const snapshotPending = state.prefix.armed ? state.prefix.pending.join("") : "";
	useEffect(() => {
		const kernel = routerPrefix(latest.current.state);
		unanswered.current = retireAnswered(unanswered.current, kernel);
		if (unanswered.current.length > 0) return;
		if (samePrefix(kernel, advanced.current)) return;
		advanced.current = kernel;
		setPrefix(kernel);
	}, [snapshotArmed, snapshotWindowMs, snapshotPending]);

	const closeCommandLine = useCallback(() => {
		setCommandLineOpen(false);
		desk.current?.focus();
	}, []);

	const closePalette = useCallback(() => {
		palette.closePalette();
		// The hook hands the caret back to whatever held it, and `document.body` is what held it on a
		// desk nobody has clicked yet — it cannot take focus, so the desk takes it instead. The check
		// runs a frame later because the dialog only gives the caret up as it unmounts, after this
		// handler returns: read synchronously it still sees the palette's own input and never fires.
		globalThis.requestAnimationFrame(() => {
			const active = globalThis.document.activeElement;
			if (active === null || active === globalThis.document.body) desk.current?.focus();
		});
	}, [palette]);

	// Both desk regions are composed from one snapshot, so the inspector and the bar's middle can
	// never disagree about which window is focused or which program it is showing.
	const snapshot = useMemo(
		() => deskSnapshotOf(state, deskTables, resolveMount),
		[state, deskTables, resolveMount],
	);
	const bar = statusFor(snapshot);
	// Composed only while the region is open: `inspectorFor` runs no program code, but the renderer
	// it hands back does, and a closed region must not be paying for one.
	const inspector = state.desk.inspectorOpen ? inspectorFor(snapshot) : null;
	// The boundary's reset key, as values: which window and which process the panel is showing. A
	// snapshot that moves focus clears a caught throw; unrelated kernel traffic leaves it alone.
	const inspecting =
		snapshot.focused === null
			? null
			: `${snapshot.focused.windowId}:${snapshot.focused.processId ?? ""}`;

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
		<div
			className="tuval-surface"
			ref={desk}
			tabIndex={-1}
			data-scheme="dark"
			// The one desk-level key fact a window renderer cannot be handed
			// (`../window/prefix-signal.ts`): while this mark is here the next key is the shell's, and
			// a region inside stands down rather than taking it (#8270). Read off the page-advanced
			// prefix, so the key right after `<c-b>` finds the mark already there (#8274).
			{...(prefix._tag === "Armed" ? {[PREFIX_ARMED_ATTRIBUTE]: "true"} : {})}
		>
			<div className="tuval-desk-body">
				<ForwardedKeyProvider value={forwarded}>
					{/* The tiling area alone, so a throw costs the founder the windows and not the status
				    line, the command line or the keyboard. The reset key is the layout's *signature*
				    and never the layout object, for the same reason the countdown above is keyed on
				    values: the boundary compares its keys with `Object.is`, and a decoded object is
				    new on every snapshot, so the panel would be torn down and rebuilt on unrelated
				    kernel traffic — losing focus on its button and the stack a founder came to read
				    (#7839). */}
					<ErrorBoundary
						label="The desk layout"
						resetKeys={[workspace === undefined ? null : layoutSignature(workspace.layout)]}
					>
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
					</ErrorBoundary>
				</ForwardedKeyProvider>
				{inspector === null ? null : <DeskInspector region={inspector} resetKeys={[inspecting]} />}
			</div>
			{commandLineOpen ? <CommandLine dispatch={dispatch} onClose={closeCommandLine} /> : null}
			{palette.open ? (
				<PaletteHost
					state={state}
					dispatch={dispatch}
					window={palette.window}
					onClose={closePalette}
				/>
			) : null}
			<StatusLine frame={statusFrame(state)} bar={bar} prefixKey={table.prefix} />
		</div>
	);
}
