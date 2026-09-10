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
 * command line is open, whether the palette is, and the repeat window's countdown (#7556).
 *
 * **The kernel is the only router.** A key is sent as `keys.press` and *nothing is done about it*
 * until the kernel answers; the answer says whether it belongs to the focused window's renderer,
 * names a command the page runs, or is the shell's own (#8274, `./press.ts`). The one thing decided
 * here at the press is whose key it is — the default action and the text-entry gate cannot wait for
 * a round trip — and that is ownership, not routing: while an answer is outstanding every key is
 * the shell's, because the kernel may have armed the prefix on a key this page has not heard back
 * about and a page that guessed would be routing.
 *
 * The command line and the palette are two doors onto one command table, never two mechanisms: the
 * `<prefix> :` line is the address you already know, `⌘K` the one you go looking through, and both
 * end at the rows in `../commands/table.ts` (#7643, `./PaletteHost.tsx`).
 */

import type {ReactElement, ReactNode} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {usePalette} from "../../palette/index.ts";
import {WindowId as ProtocolWindowId} from "../../protocol/ids.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {activeWorkspace, processOf} from "../core/index.ts";
import {inspectorFor, statusFor} from "../desk/index.ts";
import type {Key, PrefixTable} from "../keys/index.ts";
import {layoutSignature} from "../layout/index.ts";
import type {PickerEntries} from "../picker/browser.ts";
import {noEntries} from "../picker/browser.ts";
import type {PageAttachment} from "../transport/browser.ts";
import {PREFIX_ARMED_ATTRIBUTE, WindowId} from "../window/index.ts";
import {CommandLine} from "./CommandLine.tsx";
import {commandSnapshot} from "./command-snapshot.ts";
import {DeskInspector} from "./DeskInspector.tsx";
import type {DeskTables} from "./desk-snapshot.ts";
import {deskSnapshotOf, noDeskTables} from "./desk-snapshot.ts";
import {ErrorBoundary} from "./ErrorBoundary.tsx";
import {type ForwardedKey, ForwardedKeyProvider} from "./forwarded-key.tsx";
import {
	COMMAND_LINE_COMMAND,
	routerPrefix,
	shellOwnsKey,
	statusFrame,
	zoomedWindow,
} from "./frame.ts";
import {
	INITIAL_INPUT_MODALITY,
	INPUT_MODALITY_ATTRIBUTE,
	type InputModality,
	inputModalityHandlers,
} from "./input-modality.ts";
import {LayoutView} from "./LayoutView.tsx";
import type {MountResolver} from "./mount.ts";
import {focusedWindowOf, PaletteHost} from "./PaletteHost.tsx";
import type {KeyPress} from "./press.ts";
import {StatusLine} from "./StatusLine.tsx";
import {isTextEntry} from "./text-entry.ts";
import {WindowView} from "./WindowView.tsx";

/**
 * The bound on one press's ownership of the desk's keys. Far above the measured round trip (p95
 * 0.37 ms) on purpose: it is a release path for an answer that never comes, not a latency budget.
 */
const PRESS_TIMEOUT_MS = 5_000;

export interface DeskProps {
	readonly state: ShellState;
	readonly dispatch: (msg: ShellMsg) => void;
	/**
	 * How a key reaches the kernel and how its answer comes back (`./press.ts`). Required rather
	 * than defaulted: the desk forwards a key only when this answers `ToWindow`, so a desk handed no
	 * press seam would swallow every key silently instead of failing where it was wired.
	 */
	readonly press: KeyPress;
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
	/**
	 * How long a press may hold the desk's keys before ownership is released without an answer. The
	 * default is orders of magnitude above the measured round trip
	 * (`.patterns/tuval-shell-assembly.md`); a test that wants to watch the release passes its own.
	 */
	readonly pressTimeoutMs?: number;
	readonly reducedMotion?: boolean;
	/**
	 * How the palette runs a spell: this page's socket (`./PaletteHost.tsx`). Absent on a surface
	 * with no kernel behind it, and then the palette refuses a call rather than answering one itself.
	 */
	readonly call?: PageAttachment["call"];
	readonly registry?: RegistryDescription | undefined;
	readonly commandsConnected?: boolean | undefined;
	/**
	 * The operator's `windowTitles` flag (`../../features.ts`, #8721), as the desk's two halves of it
	 * read it: a window titled by its process's `title@1` line, and the process id under the
	 * inspector's heading. Off — the default — leaves both exactly as they were, and the resolver
	 * that builds the mounts is handed the same flag on the page (`../../page/AttachedDesk.tsx`).
	 */
	readonly windowTitles?: boolean;
}

export function Desk({
	state,
	dispatch,
	press,
	resolveMount,
	entries = noEntries,
	table,
	deskTables = noDeskTables,
	keyTarget,
	pressTimeoutMs = PRESS_TIMEOUT_MS,
	reducedMotion = false,
	call,
	registry,
	commandsConnected = true,
	windowTitles = false,
}: DeskProps): ReactElement {
	const [commandLineOpen, setCommandLineOpen] = useState(false);
	const [forwarded, setForwarded] = useState<ForwardedKey | null>(null);
	const [modality, setModality] = useState<InputModality>(INITIAL_INPUT_MODALITY);
	const modalityHandlers = useMemo(() => inputModalityHandlers(setModality), []);
	const seq = useRef(0);
	const desk = useRef<HTMLDivElement>(null);

	const workspace = activeWorkspace(state);
	const focused = workspace?.focused ?? null;
	const lineSnapshot = useMemo(
		() => (registry === undefined ? undefined : commandSnapshot(state, registry)),
		[state, registry],
	);

	const palette = usePalette();

	// Read through a ref so the listener is attached once per target and never re-attached on a
	// snapshot: a re-attach between two presses of one sequence would drop the second.
	const latest = useRef({state, table, focused, commandLineOpen, dispatch, press, palette});
	latest.current = {state, table, focused, commandLineOpen, dispatch, press, palette};

	// How many keys are waiting on the kernel's answer. A ref because the listener reads it at the
	// press, and because a count of outstanding round trips is not something the desk renders.
	const outstanding = useRef(0);

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
			// Whose key is this? Not what to do with it — that is the kernel's answer, below. A key
			// pressed while an answer is outstanding is the shell's whatever the snapshot says: the
			// kernel may have armed the prefix on the key before it, and this page has not heard yet.
			// That is what stops `<prefix> |` typing a pipe into whatever had focus (#8274).
			const shellOwns =
				outstanding.current > 0 || shellOwnsKey(grammar, routerPrefix(current), key);
			if (!shellOwns && isTextEntry(event.target)) return;
			// Swallowed once, where ownership is decided rather than per arm: a key the shell owns must
			// not also insert a character into the text entry underneath.
			if (shellOwns) event.preventDefault();

			// The press owns the desk's keys until it is answered *or* until the bound below runs out. A
			// promise the kernel never settles is not hypothetical — a server fiber can die between the
			// fold and the send with the socket still open — and without a release the tab swallows every
			// later key for good, the composer included (#8274).
			outstanding.current += 1;
			let released = false;
			const release = (): boolean => {
				if (released) return false;
				released = true;
				outstanding.current -= 1;
				return true;
			};
			const bound = globalThis.setTimeout(release, pressTimeoutMs);
			void latest.current.press(key).then(
				(reply) => {
					globalThis.clearTimeout(bound);
					// An answer past its own bound is acted on by nobody: the desk has already given the
					// key back, so forwarding it now would land it in whatever holds focus seconds later.
					if (!release()) return;
					if (reply._tag === "Command") {
						if (reply.name === COMMAND_LINE_COMMAND) setCommandLineOpen(true);
						return;
					}
					if (reply._tag !== "ToWindow") return;
					// The window focused when the key was pressed, not the one focused when the answer
					// came back: the kernel routed this key against the desk as it stood at the press.
					if (window === null) return;
					seq.current += 1;
					setForwarded({windowId: WindowId.make(window), key: reply.key, seq: seq.current});
				},
				() => {
					globalThis.clearTimeout(bound);
					release();
				},
			);
		},
		[pressTimeoutMs],
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
	// It runs off the snapshot, which the acknowledgement for the press moves (`../transport/wire.ts`)
	// rather than the state pump, so the window opens as the repeatable command completes rather
	// than whenever the next broadcast happens to arrive — the half of #8274 the founder felt as a
	// timer.
	//
	// The dependency is the prefix's *value*, spelled out, and never a prefix object: every snapshot
	// arrives JSON-decoded, so that object is new on each one and an effect keyed on it re-armed the
	// countdown on unrelated kernel traffic — a demo counter ticking once a second starved an armed
	// prefix indefinitely (#7782).
	const repeatWindowMs = state.prefix.armed ? state.prefix.repeatWindowMs : null;
	const pending = state.prefix.armed ? state.prefix.pending.join("") : "";
	useEffect(() => {
		if (repeatWindowMs === null) return;
		// Through the ref, so the caller's `dispatch` identity is not a dependency either — the same
		// starvation, from the other direction.
		const timer = setTimeout(() => {
			latest.current.dispatch({type: "prefix.repeatLapsed"});
		}, repeatWindowMs);
		return () => clearTimeout(timer);
		// `pending` is a dependency because each key typed into the window restarts it, exactly as
		// `startRepeatTimer` restarts the host's one timer.
	}, [repeatWindowMs, pending]);

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
			// a region inside stands down rather than taking it (#8270). Read off the kernel's own
			// prefix — the acknowledgement for `<c-b>` carries it, so the mark lands with the answer
			// rather than with the next broadcast (#8274).
			{...(state.prefix.armed ? {[PREFIX_ARMED_ATTRIBUTE]: "true"} : {})}
			// Which input the operator last used, so the ring rule in `./tokens.css` can paint on a Tab
			// and stay off a click — a text field matches `:focus-visible` either way (#8786). The pair
			// below maintains it and routes nothing; the desk's one key router is the listener above.
			{...{[INPUT_MODALITY_ATTRIBUTE]: modality}}
			{...modalityHandlers}
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
				{inspector === null ? null : (
					<DeskInspector
						region={inspector}
						resetKeys={[inspecting]}
						processId={windowTitles ? (snapshot.focused?.processId ?? null) : null}
					/>
				)}
			</div>
			{commandLineOpen ? (
				<CommandLine
					dispatch={dispatch}
					onClose={closeCommandLine}
					registry={registry}
					snapshot={lineSnapshot}
					call={commandsConnected ? call : undefined}
					window={focused === null ? undefined : ProtocolWindowId.make(focused)}
				/>
			) : null}
			{palette.open ? (
				<PaletteHost
					state={state}
					registry={registry}
					{...(call === undefined || !commandsConnected ? {} : {call})}
					window={palette.window}
					onClose={closePalette}
				/>
			) : null}
			<StatusLine frame={statusFrame(state)} bar={bar} prefixKey={table.prefix} />
		</div>
	);
}
