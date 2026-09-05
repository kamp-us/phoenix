/**
 * `ChatWindow` — the one chat renderer both AI agent programs bind (founder ruling 2026-09-02,
 * amended on #7572 / #7584). It is a `WindowRenderer` (#7553) over the `ai-agent-session` state and
 * the five ports' vocabulary, and it knows nothing about Pi or Claude: everything it reads is the
 * model-blind item union of `../../ai-agent/ports/`, and everything it sends is a Msg of
 * `../../ai-agent/core/`. Both of those are `import type` only, so this module pulls no agent code
 * into the browser bundle at all.
 *
 * Three things here are not obvious from the code:
 *
 * **The composer is not wrapped, it is driven through its bridge.** `AgentChatInput`
 * (`@kampus/design`, #7561) has no `onSubmit` — it sends through an `AgentChatInputBridge` and
 * reads its working/ready state off that bridge's event stream. `./composer-bridge.ts` is that
 * seam, and it is why the shared composer needs no Tuval-shaped fork.
 *
 * **Paging anchors on an item, not on an offset.** A page prepends rows above the viewport, so the
 * offset that meant "here" before the prepend means somewhere older after it. The window remembers
 * the id of the oldest row it held, finds that row again in the new list and scrolls back onto it —
 * which is stable whether the head row stayed (more history behind) or disappeared (the beginning
 * of history).
 *
 * **Nothing is ever auto-resent.** An `interrupted` marker renders the cut turn and offers a
 * resend; the resend is a deliberate new send and mints a fresh idempotency key (ruling 2, #7570),
 * never a retry of the key the interrupted turn used.
 */

import {AgentChatInput, Button, DesignTranslationProvider, Kbd} from "@kampus/design";
import {useVirtualizer, type VirtualizerOptions} from "@tanstack/react-virtual";
import {Effect, Fiber, Stream} from "effect";
import type {ReactElement, KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent} from "react";
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {Mode, TranscriptItem} from "../../ai-agent/ports/index.ts";
import type {ProcessView, WindowHost, WindowRenderer} from "../window/index.ts";
import {windowRenderer} from "../window/index.ts";
import {composerBridge} from "./composer-bridge.ts";
import {tuvalDesignTranslate} from "./copy.ts";
import {ModeSwitch} from "./ModeSwitch.tsx";
import {type PermissionAnswer, PermissionCards} from "./PermissionCards.tsx";
import {isWorking, phaseLine} from "./phase.ts";
import {
	type ChatRow,
	chatRows,
	mergeOlder,
	oldestLoadedId,
	rowIndexOfItem,
	rowKey,
} from "./rows.ts";
import {ToolRow} from "./ToolRow.tsx";
import {asChatView, type ChatView} from "./view.ts";
import "./chat.css";

export type ChatWindowHost = WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>;
export type ChatWindowRenderer = WindowRenderer<
	ReactNode,
	AiAgentSessionState,
	AiAgentSessionMsg,
	ChatView
>;

export interface ChatWindowOptions {
	/**
	 * The program's own extras in the status bar, beside the phase line and the mode switch.
	 *
	 * This is the whole of what a thin renderer adds on top of the shared window (founder ruling
	 * 2026-09-02, amended on #7572 / #7584), and it is a function of the live state because that is
	 * what a renderer is: `f(state, view)`. Pi's is its usage line (#7611); a program with no extras
	 * passes none and the bar renders exactly as it did before this slot existed.
	 */
	readonly extras?: (state: AiAgentSessionState) => ReactNode;
	/** Mints one idempotency key per deliberate send (ruling 2, #7570). */
	readonly newKey?: () => string;
	readonly pageLimit?: number;
	readonly overscan?: number;
	/** First guess per row, before the row is rendered and measured. */
	readonly estimateRowHeight?: number;
	/** How close to the top counts as "at the top" for the next page, in pixels. */
	readonly topThreshold?: number;
	/** How long the scroll offset settles before it is written to the view slot. */
	readonly scrollCommitMs?: number;
	/**
	 * How the transcript scrolls. The default is the virtualizer's own `element.scrollTo`; a test
	 * substitutes a recorder, because jsdom has no layout and so no scroll to observe.
	 */
	readonly scrollToFn?: VirtualizerOptions<HTMLDivElement, Element>["scrollToFn"];
}

interface ResolvedOptions {
	readonly extras: ((state: AiAgentSessionState) => ReactNode) | null;
	readonly newKey: () => string;
	readonly pageLimit: number;
	readonly overscan: number;
	readonly estimateRowHeight: number;
	readonly topThreshold: number;
	readonly scrollCommitMs: number;
	readonly scrollToFn?: VirtualizerOptions<HTMLDivElement, Element>["scrollToFn"];
}

const resolve = (options: ChatWindowOptions): ResolvedOptions => ({
	extras: options.extras ?? null,
	newKey: options.newKey ?? (() => crypto.randomUUID()),
	pageLimit: options.pageLimit ?? 50,
	overscan: options.overscan ?? 6,
	estimateRowHeight: options.estimateRowHeight ?? 72,
	topThreshold: options.topThreshold ?? 64,
	scrollCommitMs: options.scrollCommitMs ?? 150,
	...(options.scrollToFn === undefined ? {} : {scrollToFn: options.scrollToFn}),
});

/**
 * The process's public state, live. The stream never fails and ends on `ProcessGone`, so there is
 * no error arm: `null` is "nothing yet" and the gone arm is a value the surface renders.
 */
const useProcessView = (host: ChatWindowHost): ProcessView<AiAgentSessionState> | null => {
	const [view, setView] = useState<ProcessView<AiAgentSessionState> | null>(null);
	const read = host.readProcess;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(read, (next) => Effect.sync(() => setView(next))),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [read]);
	return view;
};

const Placeholder = ({children}: {readonly children: ReactNode}): ReactElement => (
	<p className="tuval-chat-placeholder" role="status">
		{children}
	</p>
);

const who: Readonly<Record<TranscriptItem["kind"], string>> = {
	user: "you",
	assistant: "agent",
	tool: "tool",
	system: "session",
};

function ItemRow({
	item,
	interrupted,
	onResend,
	expanded,
	onToggleTool,
}: {
	readonly item: TranscriptItem;
	readonly interrupted: boolean;
	readonly onResend: (() => void) | null;
	readonly expanded: boolean;
	readonly onToggleTool: (id: string, open: boolean) => void;
}): ReactElement {
	return (
		<>
			<span className="tuval-chat-who">{who[item.kind]}</span>
			{item.kind === "tool" ? (
				<ToolRow item={item} expanded={expanded} onToggle={(open) => onToggleTool(item.id, open)} />
			) : (
				<p className="tuval-chat-text">{item.text}</p>
			)}
			{interrupted ? (
				<span className="tuval-chat-interrupted">
					<span className="tuval-chat-interrupted-mark">interrupted</span>
					{onResend === null ? null : (
						<Button type="button" variant="tertiary" size="sm" onClick={onResend}>
							Resend <Kbd>Alt+R</Kbd>
						</Button>
					)}
				</span>
			) : null}
		</>
	);
}

function RowView({
	row,
	interruptedId,
	onResend,
	onOlder,
	expanded,
	onToggleTool,
}: {
	readonly row: ChatRow;
	readonly interruptedId: string | null;
	readonly onResend: (() => void) | null;
	readonly onOlder: () => void;
	readonly expanded: ReadonlySet<string>;
	readonly onToggleTool: (id: string, open: boolean) => void;
}): ReactElement {
	if (row.kind === "loading") {
		return (
			<span className="tuval-chat-head" role="status">
				Loading earlier messages…
			</span>
		);
	}
	if (row.kind === "older") {
		return (
			<span className="tuval-chat-head">
				<Button type="button" variant="tertiary" size="sm" onClick={onOlder}>
					Load earlier messages
				</Button>
				{row.items > 0 ? <span>{row.items} omitted here</span> : null}
			</span>
		);
	}
	return (
		<ItemRow
			item={row.item}
			interrupted={row.item.id === interruptedId}
			onResend={row.item.id === interruptedId ? onResend : null}
			expanded={expanded.has(row.item.id)}
			onToggleTool={onToggleTool}
		/>
	);
}

function ChatWindow({
	host,
	options,
}: {
	readonly host: ChatWindowHost;
	readonly options: ResolvedOptions;
}): ReactElement {
	const hostRef = useRef(host);
	hostRef.current = host;

	const process = useProcessView(host);
	const state = process?._tag === "Live" ? process.state : null;

	// The slot is read once and then owned here: it is this window's own scratch space, and a
	// re-read on every render would fight the writes below on a host whose `view()` lags a commit.
	const [view, setViewLocal] = useState<ChatView>(() => asChatView(host.view()));
	const [older, setOlder] = useState<ReadonlyArray<TranscriptItem>>([]);
	const [loading, setLoading] = useState(false);

	const commit = useCallback((next: (current: ChatView) => ChatView) => {
		setViewLocal((current) => {
			const value = next(current);
			void Effect.runFork(hostRef.current.setView(value));
			return value;
		});
	}, []);

	const dispatch = useCallback((msg: AiAgentSessionMsg) => {
		void Effect.runFork(hostRef.current.dispatch(msg));
	}, []);

	const expanded = useMemo(() => new Set(view.expanded), [view.expanded]);

	/** The row just opened, until the layout effect below has scrolled its trigger back into view. */
	const openedRef = useRef<string | null>(null);

	const toggleTool = useCallback(
		(id: string, open: boolean) => {
			if (open) openedRef.current = id;
			commit((current) => {
				const held = current.expanded.includes(id);
				if (held === open) return current;
				return {
					...current,
					expanded: open
						? [...current.expanded, id]
						: current.expanded.filter((other) => other !== id),
				};
			});
		},
		[commit],
	);

	const answerPermission = useCallback(
		(answer: PermissionAnswer) => dispatch({type: "answer", ...answer}),
		[dispatch],
	);

	const setMode = useCallback((mode: Mode) => dispatch({type: "setMode", mode}), [dispatch]);

	const rows = useMemo(
		() =>
			chatRows({
				older,
				tail: state?.transcript.items ?? [],
				omitted: state?.transcript.omitted.items ?? 0,
				loading,
				atOldest: view.atOldest,
			}),
		[older, state, loading, view.atOldest],
	);

	/** The row the viewport was resting on when the current page was asked for. */
	const anchorRef = useRef<string | null>(null);
	/** Set when a page lands, cleared by the layout effect that re-anchors the viewport onto it. */
	const reanchorRef = useRef(false);
	const seenPageRef = useRef<AiAgentSessionState["lastPage"]>(null);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => options.estimateRowHeight,
		getItemKey: (index) => rowKey(rows[index] ?? {kind: "loading"}),
		overscan: options.overscan,
		// `measureElement` runs as a React `ref` callback, so a row whose measured height differs
		// from the estimate notifies during the commit — and this binding's default turns a `sync`
		// notification into `flushSync(rerender)` (`@tanstack/react-virtual@3.14.10`,
		// `useVirtualizerBase`). React refuses that from inside a lifecycle method, and a real load
		// of this window printed sixteen of those errors. Off, the same update lands through React's
		// own scheduling on the next render.
		useFlushSync: false,
		...(options.scrollToFn === undefined ? {} : {scrollToFn: options.scrollToFn}),
	});

	const requestOlder = useCallback(() => {
		if (loading || view.atOldest || rows.length === 0) return;
		const before = oldestLoadedId(rows);
		if (before === null) return;
		anchorRef.current = before;
		setLoading(true);
		dispatch({type: "page", before, limit: options.pageLimit});
	}, [loading, view.atOldest, rows, dispatch, options.pageLimit]);

	// `lastPage` is shared session state, so every mounted window sees a page any one of them asked
	// for (#7860). A window consumes one only while its own request is out: without the `loading`
	// guard a window that scrolled nowhere gets the other's history prepended and its `atOldest`
	// advanced, which is what made the per-window cursor a slot that never diverged. The seen-marker
	// is set either way, so a window that ignored a page does not merge it later when it does ask.
	//
	// The guard is a proxy, not a correlation, and #7860 stays open on the residual: `loading`
	// answers "is *my* request out", but `lastPage` carries no requester and `page` (`core/machine.ts`)
	// issues its Cmd with no in-flight guard — so two windows whose requests overlap each still merge
	// whichever reply lands first. Closing that needs the reply to name the window that asked, which
	// is a change to the Msg and the core rather than to this effect.
	useEffect(() => {
		const page = state?.lastPage ?? null;
		if (page === null || page === seenPageRef.current) return;
		seenPageRef.current = page;
		if (!loading) return;
		setOlder((held) => mergeOlder(held, page.items));
		setLoading(false);
		reanchorRef.current = true;
		commit((current) => ({
			...current,
			cursor: page.items[0]?.id ?? current.cursor,
			atOldest: !page.hasMore,
		}));
	}, [state?.lastPage, loading, commit]);

	useLayoutEffect(() => {
		if (!reanchorRef.current) return;
		reanchorRef.current = false;
		const index = rowIndexOfItem(rows, anchorRef.current);
		if (index >= 0) virtualizer.scrollToIndex(index, {align: "start"});
	}, [rows, virtualizer]);

	// An expanded row grows downward from its own top, so a row opened near the bottom pushes its
	// own trigger off the top edge — the operator clicks a disclosure and the thing they clicked
	// leaves the screen. Anchoring the opened row to the top puts the trigger back above its panel.
	useLayoutEffect(() => {
		const opened = openedRef.current;
		if (opened === null) return;
		openedRef.current = null;
		const index = rowIndexOfItem(rows, opened);
		if (index >= 0) virtualizer.scrollToIndex(index, {align: "start"});
		// `view.expanded` is the dependency that matters: opening a row leaves `rows` untouched —
		// the list is the same items — so an effect keyed on `rows` alone would never run.
	}, [view.expanded, rows, virtualizer]);

	// First paint lands where a chat belongs: on the newest turn, or back on the offset this window
	// was left at. Once, and never again — a later re-render must not yank the operator's scroll.
	const placedRef = useRef(false);
	useLayoutEffect(() => {
		if (placedRef.current || rows.length === 0) return;
		placedRef.current = true;
		if (view.scroll > 0) virtualizer.scrollToOffset(view.scroll);
		else virtualizer.scrollToIndex(rows.length - 1, {align: "end"});
	}, [rows.length, view.scroll, virtualizer]);

	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (commitTimer.current !== null) clearTimeout(commitTimer.current);
		},
		[],
	);

	const onScroll = useCallback(
		(event: UIEvent<HTMLDivElement>) => {
			const offset = event.currentTarget.scrollTop;
			if (commitTimer.current !== null) clearTimeout(commitTimer.current);
			commitTimer.current = setTimeout(() => {
				commitTimer.current = null;
				commit((current) => (current.scroll === offset ? current : {...current, scroll: offset}));
			}, options.scrollCommitMs);
			if (offset <= options.topThreshold) requestOlder();
		},
		[commit, options.scrollCommitMs, options.topThreshold, requestOlder],
	);

	const phase = state?.phase ?? "idle";
	const composer = useMemo(
		() =>
			composerBridge({
				initialPhase: phase,
				onPrompt: (text) => {
					dispatch({type: "prompt", text, key: options.newKey()});
					commit((current) => (current.draft === "" ? current : {...current, draft: ""}));
				},
				onInterrupt: () => dispatch({type: "interrupt"}),
			}),
		// `phase` seeds the bridge and is deliberately not a dependency: `AgentChatInput` re-runs its
		// whole load on a new bridge identity, so a bridge rebuilt per phase would drop the composer
		// back into `loading` on every turn. The phase reaches it through `setPhase` below instead.
		[dispatch, commit, options.newKey],
	);
	useEffect(() => composer.setPhase(phase), [composer, phase]);

	const interruptedId = state?.interrupted ?? null;
	const lastPrompt = state?.lastPrompt ?? null;
	const resend = useCallback(() => {
		if (lastPrompt === null) return;
		dispatch({type: "prompt", text: lastPrompt, key: options.newKey()});
	}, [dispatch, lastPrompt, options.newKey]);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape" && isWorking(phase)) {
				event.preventDefault();
				dispatch({type: "interrupt"});
				return;
			}
			if (event.altKey && (event.key === "r" || event.key === "R") && interruptedId !== null) {
				event.preventDefault();
				resend();
			}
		},
		[dispatch, interruptedId, phase, resend],
	);

	if (process === null) {
		return (
			<div className="tuval-chat" data-scheme="dark" data-window={host.windowId}>
				<Placeholder>This window has nothing to show yet.</Placeholder>
			</div>
		);
	}
	if (process._tag === "ProcessGone") {
		return (
			<div className="tuval-chat" data-scheme="dark" data-window={host.windowId}>
				<Placeholder>
					Process {process.processId} is gone. The window is still yours — open something else in
					it.
				</Placeholder>
			</div>
		);
	}

	return (
		// The two window-wide keys (Escape while a turn runs, Alt+R to resend) belong to the window
		// rather than to any one control inside it, so the container listens on the bubble while the
		// composer's textarea keeps focus. A named `section` is what that owes a screen reader: the
		// phase line, the transcript and the composer are one named region, and every control inside
		// it is a real `button` or `textarea` with its own keyboard behaviour.
		<section
			className="tuval-chat"
			aria-label="Agent chat"
			data-scheme="dark"
			data-window={host.windowId}
			onKeyDown={onKeyDown}
		>
			<div className="tuval-chat-bar">
				<p className="tuval-chat-phase" data-phase={phase} role="status">
					<span className="tuval-chat-phase-dot" aria-hidden="true" />
					{phaseLine(phase)}
				</p>
				<div className="tuval-chat-bar-end">
					{options.extras === null ? null : options.extras(process.state)}
					<ModeSwitch modes={process.state.modes} onSetMode={setMode} />
				</div>
			</div>
			<div
				ref={scrollRef}
				className="tuval-chat-transcript"
				onScroll={onScroll}
				role="log"
				aria-label="Transcript"
				// The scroll container is the only way to older turns on a plain transcript, so a
				// keyboard user must be able to focus it (axe scrollable-region-focusable).
				tabIndex={0}
			>
				<div className="tuval-chat-spacer" style={{height: `${virtualizer.getTotalSize()}px`}}>
					{virtualizer.getVirtualItems().map((virtual) => {
						const row = rows[virtual.index];
						if (row === undefined) return null;
						return (
							<div
								key={virtual.key}
								className="tuval-chat-row"
								data-index={virtual.index}
								data-kind={row.kind === "item" ? row.item.kind : row.kind}
								ref={virtualizer.measureElement}
								style={{transform: `translateY(${virtual.start}px)`}}
							>
								<RowView
									row={row}
									interruptedId={interruptedId}
									onResend={lastPrompt === null ? null : resend}
									onOlder={requestOlder}
									expanded={expanded}
									onToggleTool={toggleTool}
								/>
							</div>
						);
					})}
				</div>
			</div>
			<DesignTranslationProvider translate={tuvalDesignTranslate}>
				<PermissionCards permissions={process.state.permissions} onAnswer={answerPermission} />
				<AgentChatInput
					variant="focused"
					bridge={composer.bridge}
					initialValue={view.draft}
					onDraftChange={(draft) =>
						commit((current) => (current.draft === draft ? current : {...current, draft}))
					}
				/>
			</DesignTranslationProvider>
		</section>
	);
}

/**
 * The renderer a program row's `RendererRef` resolves to. `windowRenderer` fixes the host shape off
 * the annotated parameter, so a renderer table that hands this one another program's host is a
 * compile error at the table (`../window/renderer.ts`).
 */
export const chatWindow = (options: ChatWindowOptions = {}): ChatWindowRenderer => {
	const resolved = resolve(options);
	return windowRenderer("host-native", (host: ChatWindowHost) => (
		<ChatWindow host={host} options={resolved} />
	));
};
