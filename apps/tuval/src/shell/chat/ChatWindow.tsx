/**
 * `ChatWindow` — the one chat renderer both AI agent programs bind (founder ruling 2026-09-02,
 * amended on #7572 / #7584). It is a `WindowRenderer` (#7553) over the `ai-agent-session` state and
 * the five ports' vocabulary, and it knows nothing about Pi or Claude: everything it reads is the
 * model-blind item union of `../../ai-agent/ports/`, and everything it sends is a Msg of
 * `../../ai-agent/core/`. Only the pure snapshot predicate is imported at runtime; no backend
 * or agent service reaches the browser.
 *
 * Four things here are not obvious from the code:
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
 * **Four writes move the transcript, and one pin decides between them.** A window resting on its
 * newest turn follows every turn that lands; one whose reader scrolled up is left alone, and so is
 * one anchored on a history page, on a row it just expanded or on a fold it just opened. That is
 * `view.pinned`: it is set from the scroll offset on every scroll *the reader* makes — a scroll the
 * window issued itself is exempt, or a follow scroll landing behind a reply that grew again would
 * clear the pin it was following on — cleared by opening a row's own
 * disclosure, opening a group's fold or asking for a page of history, and set again by sending. Two
 * anchoring effects reach the viewport only while it is clear, and every door into them clears it
 * itself rather than trusting the geometry to have done so: a transcript barely taller than its
 * viewport is inside the top threshold and the bottom one at once.
 *
 * **Nothing is ever auto-resent.** An `interrupted` marker renders the cut turn and offers a
 * resend; the resend is a deliberate new send and mints a fresh idempotency key (ruling 2, #7570),
 * never a retry of the key the interrupted turn used. The same holds for a send that never landed:
 * the window keeps the text (`./outgoing.ts`) and offers it back, and putting it in the composer is
 * as far as recovery goes.
 */

import {AgentChatInput, Button, DesignTranslationProvider, Kbd, Markdown} from "@kampus/design";
import {elementScroll, useVirtualizer, type VirtualizerOptions} from "@tanstack/react-virtual";
import {Effect, Fiber, Stream} from "effect";
import type {ReactElement, KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent} from "react";
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {isAiAgentSessionState} from "../../ai-agent/core/snapshot.ts";
import type {Mode, TranscriptItem} from "../../ai-agent/ports/index.ts";
import {FOCUS_LIST_KEY} from "../keys/syntax.ts";
import {useForwardedKey} from "../ui/forwarded-key.tsx";
import type {ProcessView, WindowHost, WindowRenderer} from "../window/index.ts";
import {prefixArmedAround, windowRenderer} from "../window/index.ts";
import {CompactionMarker} from "./CompactionMarker.tsx";
import {composerBridge} from "./composer-bridge.ts";
import {tuvalDesignTranslate, tuvalSubagentViewTranslate} from "./copy.ts";
import {ModeSwitch} from "./ModeSwitch.tsx";
import {dropSend, holdSend, readHeld, recoverInto} from "./outgoing.ts";
import {type PermissionAnswer, PermissionCards} from "./PermissionCards.tsx";
import {interruptionGraceMillis, isWorking, statusLine, workingTell} from "./phase.ts";
import {QueuedMessages} from "./QueuedMessages.tsx";
import {
	type ChatRow,
	chatRows,
	mergeOlder,
	olderPageRequest,
	type RowItem,
	rowIndexOfItem,
	rowKey,
	subagentHeads,
	subagentRows,
} from "./rows.ts";
import {SessionRow} from "./SessionRow.tsx";
import {SubagentList, type SubagentListHandle} from "./SubagentList.tsx";
import {ThinkingRow} from "./ThinkingRow.tsx";
import {type ToolFold, ToolRow} from "./ToolRow.tsx";
import {UnsentMessages} from "./UnsentMessages.tsx";
import {asChatView, type ChatView, viewMain, viewSubagent} from "./view.ts";
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
	 * The program's own extras in the status bar, beside the phase line.
	 *
	 * This is the whole of what a thin renderer adds on top of the shared window (founder ruling
	 * 2026-09-02, amended on #7572 / #7584), and it is a function of the live state because that is
	 * what a renderer is: `f(state, view)`. **No program passes one today**: the founder's 2026-09-05
	 * ruling (#8190) sent both backends' usage and session lines to the desk inspector, so the bar
	 * carries the phase line alone. The slot itself stays — retiring it is a separate call — and a
	 * program with no extras renders exactly the bar both backends render now.
	 */
	readonly extras?: (state: AiAgentSessionState) => ReactNode;
	/** Mints one idempotency key per deliberate send (ruling 2, #7570). */
	readonly newKey?: () => string;
	/** The clock a send stamps its turn with, so no update cell has to read one (#7978). */
	readonly now?: () => number;
	/**
	 * The window's half of the config's `features.subagentList` flag (`../../config.ts`), on by
	 * default since the flag's flip. It gates the running list and the removal of a subagent's rows
	 * from the transcript together, so a caller passing `false` gets exactly the pre-flag window
	 * (#8405).
	 */
	readonly subagentList?: boolean;
	readonly pageLimit?: number;
	readonly overscan?: number;
	/** First guess per row, before the row is rendered and measured. */
	readonly estimateRowHeight?: number;
	/** How close to the top counts as "at the top" for the next page, in pixels. */
	readonly topThreshold?: number;
	/** How much tail may hang below the fold and still count as "on the newest turn", in pixels. */
	readonly bottomThreshold?: number;
	/** How long the scroll offset settles before it is written to the view slot. */
	readonly scrollCommitMs?: number;
	/**
	 * How the transcript scrolls. The default is the virtualizer's own `element.scrollTo`; a test
	 * substitutes a recorder, because jsdom has no layout and so no scroll to observe.
	 */
	readonly scrollToFn?: VirtualizerOptions<HTMLDivElement, Element>["scrollToFn"];
}

/**
 * What a thin binding's own caller may set: every window option except `extras`, which the binding
 * owns. A binding exists to fill that slot (founder ruling 2026-09-02, amended on #7572 / #7584), so
 * a caller reaching it through the binding would be asking for the shared window under the binding's
 * name — and before this type that argument compiled, ran, and was dropped without a signal (#7957).
 */
export type ThinChatWindowOptions = Omit<ChatWindowOptions, "extras">;

interface ResolvedOptions {
	readonly extras: ((state: AiAgentSessionState) => ReactNode) | null;
	readonly newKey: () => string;
	readonly now: () => number;
	readonly subagentList: boolean;
	readonly pageLimit: number;
	readonly overscan: number;
	readonly estimateRowHeight: number;
	readonly topThreshold: number;
	readonly bottomThreshold: number;
	readonly scrollCommitMs: number;
	readonly scrollToFn?: VirtualizerOptions<HTMLDivElement, Element>["scrollToFn"];
}

const resolve = (options: ChatWindowOptions): ResolvedOptions => ({
	extras: options.extras ?? null,
	newKey: options.newKey ?? (() => crypto.randomUUID()),
	now: options.now ?? (() => Date.now()),
	subagentList: options.subagentList !== false,
	pageLimit: options.pageLimit ?? 50,
	overscan: options.overscan ?? 6,
	estimateRowHeight: options.estimateRowHeight ?? 72,
	topThreshold: options.topThreshold ?? 64,
	bottomThreshold: options.bottomThreshold ?? 64,
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

/**
 * A bare printable character typed on the transcript belongs to nobody: the scroll region has no
 * text to take it, and letting it reach the desk's one keyboard listener either arms the prefix or
 * forwards it into the window's process (#7973). Modified keys are somebody else's — the desk
 * prefix is Ctrl-keyed and Alt+R is the window's — and so is every named key the region scrolls on.
 *
 * Unless the shell's prefix is armed, and then the bare key *is* the shell's: it is the second key
 * of a sequence the operator already started, and swallowing it here is what left `<prefix> w`
 * dead from the transcript all day (#8270).
 */
const swallowBareCharacter = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
	const bare = !event.ctrlKey && !event.metaKey && !event.altKey && [...event.key].length === 1;
	if (bare && !prefixArmedAround(event.target)) event.stopPropagation();
};

/**
 * Is the transcript resting on its newest turn? The list is virtualized, so the mounted rows are
 * the overscan window and their heights are not the transcript's height — the tail hanging below
 * the fold is the virtualizer's total size against the scroller's own viewport.
 */
const onNewest = (scroller: HTMLDivElement | null, totalSize: number, threshold: number): boolean =>
	scroller !== null && totalSize - (scroller.scrollTop + scroller.clientHeight) <= threshold;

const Placeholder = ({children}: {readonly children: ReactNode}): ReactElement => (
	<p className="tuval-chat-placeholder" role="status">
		{children}
	</p>
);

// No `system` key, and none is missing: a session notice is a `session` row, never an item row.
const who: Readonly<Record<RowItem["kind"], string>> = {
	user: "you",
	assistant: "agent",
	tool: "tool",
	thinking: "thinking",
	compaction: "compaction",
};

/**
 * The row's author, in the words the dropped label used to print. This is now the only text that
 * names it, so a nested row states both whose words these are and that they ran inside another
 * call: the indent is the second signal, never the only one (ADR 0162, Pillar 4).
 */
const authorName = (kind: RowItem["kind"], nested: boolean): string =>
	nested ? `${who[kind]}, inside a subagent call` : who[kind];

/**
 * What a row shows under its label. Three kinds carry a shape of their own, and all three are
 * disclosures over this window's one `expanded` set: a tool call, a thinking row, and a compaction
 * boundary, whose divider line is the trigger and whose summary is the panel. A session line never
 * reaches here: `RowView` folds those
 * into the session row. Everything else, an agent reply and what the operator typed alike,
 * renders through the shared markdown block, which paints synchronously so the row's measurement
 * still holds (#8012/#8226): a fence the operator sends is the fence the agent received.
 */
function RowBody({
	item,
	expanded,
	fold,
	onToggleRow,
}: {
	readonly item: RowItem;
	readonly expanded: boolean;
	readonly fold: ToolFold | null;
	readonly onToggleRow: (id: string, open: boolean) => void;
}): ReactElement {
	if (item.kind === "tool") {
		return (
			<ToolRow
				item={item}
				expanded={expanded}
				fold={fold}
				onToggle={(open) => onToggleRow(item.id, open)}
			/>
		);
	}
	if (item.kind === "thinking") {
		return (
			<ThinkingRow
				item={item}
				expanded={expanded}
				onToggle={(open) => onToggleRow(item.id, open)}
			/>
		);
	}
	if (item.kind === "compaction") {
		return (
			<CompactionMarker
				text={item.text}
				expanded={expanded}
				onToggle={(open) => onToggleRow(item.id, open)}
			/>
		);
	}
	// The transcript is a region inside the desk, so a `#` heading in a message is a subsection of
	// it rather than a page title; and a transcript row is read as the lines it was typed on, so a
	// lone newline is a break here where a document-shaped surface would fold it (#8244).
	return (
		<Markdown className="tuval-chat-markdown" headingBase={3} breaks>
			{item.text}
		</Markdown>
	);
}

function ItemRow({
	item,
	interrupted,
	onResend,
	expanded,
	fold,
	nested,
	onToggleRow,
}: {
	readonly item: RowItem;
	readonly interrupted: boolean;
	readonly onResend: (() => void) | null;
	readonly expanded: boolean;
	readonly fold: ToolFold | null;
	readonly nested: boolean;
	readonly onToggleRow: (id: string, open: boolean) => void;
}): ReactElement {
	return (
		<>
			{/*
			 * The visible label is gone; what carries authorship is the row's own shape plus
			 * `data-message-role` on its wrapper. The name is announced on every row rather than on
			 * author change, because the list is virtualized and a reader may land on any row cold.
			 */}
			<span className="kp-visually-hidden">{authorName(item.kind, nested)}</span>
			<RowBody item={item} expanded={expanded} fold={fold} onToggleRow={onToggleRow} />
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
	unfolded,
	onToggleRow,
	onToggleFold,
	onViewSubagent,
}: {
	readonly row: ChatRow;
	readonly interruptedId: string | null;
	readonly onResend: (() => void) | null;
	readonly onOlder: () => void;
	readonly expanded: ReadonlySet<string>;
	readonly unfolded: ReadonlySet<string>;
	readonly onToggleRow: (id: string, open: boolean) => void;
	readonly onToggleFold: (id: string, open: boolean) => void;
	readonly onViewSubagent: ((id: string) => void) | null;
}): ReactElement {
	if (row.kind === "loading") {
		return (
			<span className="tuval-chat-head" role="status">
				Loading earlier messages…
			</span>
		);
	}
	if (row.kind === "page-error") {
		return (
			<span className="tuval-chat-head">
				<span role="status">Could not load earlier messages: {row.detail}</span>
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					style={{minBlockSize: "var(--tap-min, 36px)"}}
					onClick={onOlder}
				>
					Retry loading earlier messages
				</Button>
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
	if (row.kind === "session") {
		// The run's first notice is its identity, in the `expanded` set as in `rowKey`, so a notice
		// joining the run behind it does not close a disclosure the reader opened.
		const id = row.items[0].id;
		return (
			<>
				<span className="tuval-chat-who">session</span>
				<SessionRow
					run={row.items}
					expanded={expanded.has(id)}
					onToggle={(next) => onToggleRow(id, next)}
					onViewSubagent={onViewSubagent}
				/>
			</>
		);
	}
	const open = unfolded.has(row.item.id);
	return (
		<ItemRow
			item={row.item}
			interrupted={row.item.id === interruptedId}
			onResend={row.item.id === interruptedId ? onResend : null}
			expanded={expanded.has(row.item.id)}
			fold={
				row.nestedIds.length === 0
					? null
					: {
							count: row.nestedIds.length,
							open,
							onToggle: (next) => onToggleFold(row.item.id, next),
						}
			}
			nested={row.nested}
			onToggleRow={onToggleRow}
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
	const session =
		state === null
			? undefined
			: JSON.stringify([host.processId, state.sessionId, state.connection]);

	// The slot is read once and then owned here: it is this window's own scratch space, and a
	// re-read on every render would fight the writes below on a host whose `view()` lags a commit.
	const [view, setViewLocal] = useState<ChatView>(() => asChatView(host.view()));
	const [older, setOlder] = useState<ReadonlyArray<TranscriptItem>>([]);
	const [loading, setLoading] = useState(false);
	const [pageError, setPageError] = useState<string | null>(null);

	// The last committed view, so `commit` can apply `next` and fork the host write out here rather
	// than inside the `setViewLocal` updater. React documents an updater as pure and re-invokes it —
	// `StrictMode` does so on every commit, and Tuval only ever runs in development (ADR 0345) — so
	// a `runFork` in there is two `setView` calls per keystroke. The ref is written in the same tick
	// as the state, which is what keeps two commits batched into one render composing: the debounced
	// scroll offset and `toggleRow`'s expanded set both read what the previous commit wrote.
	const viewRef = useRef(view);

	const commit = useCallback((next: (current: ChatView) => ChatView) => {
		const current = viewRef.current;
		const value = next(current);
		// The identity has to stop the host write and not just the local one: `window.setView`
		// rebuilds `ShellState` wholesale (`../core/machine.ts`), so a no-change write from
		// `onScroll` re-renders every subscriber of the desk once per scroll frame — the cost
		// the `scrollCommitMs` debounce beside it exists to bound.
		if (value === current) return;
		viewRef.current = value;
		void Effect.runFork(hostRef.current.setView(value));
		setViewLocal(value);
	}, []);

	const dispatch = useCallback((msg: AiAgentSessionMsg) => {
		void Effect.runFork(hostRef.current.dispatch(msg));
	}, []);

	const expanded = useMemo(() => new Set(view.expanded), [view.expanded]);
	const unfolded = useMemo(() => new Set(view.unfolded), [view.unfolded]);

	/** The row just opened, until the layout effect below has scrolled its trigger back into view. */
	const openedRef = useRef<string | null>(null);

	const toggleRow = useCallback(
		(id: string, open: boolean) => {
			if (open) openedRef.current = id;
			commit((current) => {
				const held = current.expanded.includes(id);
				if (held === open) return current;
				return {
					...current,
					// The effect below anchors an opened row to the top, and a window still following
					// its newest turn would pull the viewport straight back off it.
					pinned: open ? false : current.pinned,
					expanded: open
						? [...current.expanded, id]
						: current.expanded.filter((other) => other !== id),
				};
			});
		},
		[commit],
	);

	const toggleFold = useCallback(
		(id: string, open: boolean) => {
			if (open) openedRef.current = id;
			commit((current) => {
				const held = current.unfolded.includes(id);
				if (held === open) return current;
				return {
					...current,
					// Same as an opened tool row: a revealed fold is anchored, and a following window
					// would pull the viewport straight back off it.
					pinned: open ? false : current.pinned,
					unfolded: open
						? [...current.unfolded, id]
						: current.unfolded.filter((other) => other !== id),
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

	// The slots the flag makes rows disappear behind. Off, it is the shared empty set and `chatRows`
	// folds exactly as it did; on, every row whose parent chain reaches one of these leaves the
	// transcript (#8405).
	const subagentSlots = state?.subagents ?? null;
	const subagents = useMemo(
		() => subagentHeads(subagentSlots, options.subagentList),
		[options.subagentList, subagentSlots],
	);

	/**
	 * Which transcript the one view slot is showing (founder ruling Q7 on #8384), or `null` for the
	 * agent's own. Gated on the flag rather than trusted from the slot: a slot written while the flag
	 * was on must not keep a window swapped away once it is off (#8405's containment).
	 */
	const viewing = options.subagentList ? view.viewing : null;
	const viewedSlot = viewing === null ? undefined : state?.subagents[viewing.id];

	/** The scroll offset `onScroll` is holding for its settle window, and the timer holding it. */
	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const restingAt = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (commitTimer.current !== null) clearTimeout(commitTimer.current);
		},
		[],
	);

	/**
	 * Write the held offset now, so `scroll` describes where the *current* view rests before another
	 * one takes its place.
	 *
	 * A swap that skipped this would be wrong twice over one debounce: `viewSubagent` would park an
	 * offset up to `scrollCommitMs` behind where the reader actually is, and the timer would then fire
	 * past the swap and write main's offset onto the subagent's `scroll` — a field that means a
	 * different transcript now (review round 1 on #8467).
	 */
	const settleScroll = useCallback(() => {
		if (commitTimer.current !== null) clearTimeout(commitTimer.current);
		commitTimer.current = null;
		const offset = restingAt.current;
		restingAt.current = null;
		if (offset === null) return;
		commit((current) => (current.scroll === offset ? current : {...current, scroll: offset}));
	}, [commit]);

	const showSubagent = useCallback(
		(id: string) => {
			settleScroll();
			commit((current) => viewSubagent(current, id));
		},
		[commit, settleScroll],
	);
	const showMain = useCallback(() => {
		settleScroll();
		commit(viewMain);
	}, [commit, settleScroll]);

	/**
	 * `<c-b> a`, arriving as the key that chord's command row mints (`../commands/table.ts`). The
	 * shell cannot address a renderer by name, so the binding forwards a key instead and this is the
	 * window's whole share of it: hand the list its focus, or — with the flag off, where no list is
	 * rendered and this ref is null — do nothing at all.
	 */
	const navigatorRef = useRef<SubagentListHandle>(null);
	useForwardedKey(host.windowId, (key) => {
		if (key !== FOCUS_LIST_KEY) return;
		navigatorRef.current?.focus();
	});

	const mainRows = useMemo(
		() =>
			chatRows({
				older,
				tail: state?.transcript.items ?? [],
				omitted: state?.transcript.omitted.items ?? 0,
				loading,
				pageError,
				atOldest: view.atOldest,
				unfolded,
				subagents,
			}),
		[older, state, loading, pageError, view.atOldest, unfolded, subagents],
	);

	// The swap is a swap of *this* list and nothing else: main's own rows, pages and cursor are left
	// exactly as they were, which is what lets the back action put the window back where it was.
	const rows = useMemo(
		() => (viewedSlot === undefined ? mainRows : subagentRows(viewedSlot, unfolded)),
		[viewedSlot, mainRows, unfolded],
	);

	/** The row the viewport was resting on when the current page was asked for. */
	const anchorRef = useRef<string | null>(null);
	/** Set when a page lands, cleared by the layout effect that re-anchors the viewport onto it. */
	const reanchorRef = useRef(false);
	const pageRequestRef = useRef<object | null>(null);
	const sessionRef = useRef(session);
	sessionRef.current = session;
	const priorSessionRef = useRef(session);
	useEffect(() => {
		if (priorSessionRef.current !== undefined && priorSessionRef.current !== session) {
			pageRequestRef.current = null;
			setLoading(false);
			setPageError(null);
			setOlder([]);
			commit((current) => ({...current, cursor: null, atOldest: false}));
		}
		priorSessionRef.current = session;
		return () => {
			pageRequestRef.current = null;
		};
	}, [session, commit]);

	const scrollRef = useRef<HTMLDivElement | null>(null);

	/**
	 * The offset this window last asked its scroller for, until the scroll event carrying it lands.
	 *
	 * A scroll the window issued itself is not the reader moving, and `onScroll` below reads it as
	 * one without this: the follow effect scrolls to the newest row once per measurement of a
	 * growing turn, and each of those lands at an offset the *next* measurement has already put
	 * behind the content end — so `onNewest` answers "not on the newest turn", the pin clears, and
	 * the follow stops dead in the middle of a streaming reply (#8174).
	 */
	const selfScrollRef = useRef<number | null>(null);
	const scrollToFn = useCallback<
		NonNullable<VirtualizerOptions<HTMLDivElement, Element>["scrollToFn"]>
	>(
		(offset, scroll, instance) => {
			selfScrollRef.current = offset + (scroll.adjustments ?? 0);
			(options.scrollToFn ?? elementScroll)(offset, scroll, instance);
		},
		[options.scrollToFn],
	);

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
		scrollToFn,
	});

	const totalSize = virtualizer.getTotalSize();

	const requestOlder = useCallback(() => {
		// A subagent's rows arrive whole with its slot, so there is no page behind them to ask for —
		// and the ids in this list are the worker's, which the agent's own cursor knows nothing about.
		if (viewing !== null) return;
		if (pageRequestRef.current !== null || view.atOldest || rows.length === 0) return;
		const request = olderPageRequest(rows);
		if (request === null) return;
		const {before, anchor} = request;
		const sessionId = state?.sessionId;
		const connection = state?.connection;
		pageRequestRef.current = request;
		anchorRef.current = anchor;
		setPageError(null);
		setLoading(true);
		commit((current) => (current.pinned ? {...current, pinned: false} : current));
		// Processes.dispatchFolded holds its lock through idle AND the state read (#8274).
		// Only this dispatch's completion can settle it; broadcast snapshots retain old outcomes.
		void Effect.runFork(
			Effect.gen(function* () {
				const reply = yield* hostRef.current.dispatch({
					type: "page",
					before,
					limit: options.pageLimit,
				});
				if (pageRequestRef.current !== request || sessionRef.current !== session) return;
				pageRequestRef.current = null;
				setLoading(false);
				const completed = reply._tag === "Delivered" ? reply.view?.state : null;
				if (
					!isAiAgentSessionState(completed) ||
					completed.sessionId !== sessionId ||
					completed.connection !== connection ||
					completed.pageOutcome === null
				) {
					setPageError("The page request could not be confirmed. Try again.");
					return;
				}
				const outcome = completed.pageOutcome;
				if (outcome.status === "refused") {
					setPageError(outcome.failure.detail);
					return;
				}
				const page = outcome.page;
				setOlder((held) => mergeOlder(held, page.items));
				setPageError(null);
				reanchorRef.current = true;
				commit((current) => ({
					...current,
					cursor: page.items[0]?.id ?? current.cursor,
					atOldest: !page.hasMore,
				}));
			}),
		);
	}, [
		viewing,
		view.atOldest,
		rows,
		session,
		state?.sessionId,
		state?.connection,
		commit,
		options.pageLimit,
	]);

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
		// `view.expanded` and `view.unfolded` are the dependencies that matter: opening an ordinary row
		// leaves `rows` untouched — the list is the same items — so an effect keyed on `rows` alone
		// would never run for it. A fold is the case where both change, and the lookup covers either.
	}, [view.expanded, view.unfolded, rows, virtualizer]);

	// First paint lands where a chat belongs: on the newest turn, or back on the offset this window
	// was left at. Once, and never again — a later re-render must not yank the operator's scroll.
	// A window left following its newest turn is restored onto the newest row and not onto its saved
	// offset: that offset was the bottom when it was written, and the transcript has grown since.
	const placedRef = useRef(false);
	// …and once per swap after that. A swapped-in view is a different transcript, so the offset the
	// viewport holds means nothing in it: the placement below runs again, onto the newest row of the
	// subagent, or back onto the row and offset `viewMain` restored for the agent's own.
	const placedViewRef = useRef<string | null>(viewing?.id ?? null);
	useLayoutEffect(() => {
		const id = viewing?.id ?? null;
		if (placedViewRef.current === id) return;
		placedViewRef.current = id;
		placedRef.current = false;
	}, [viewing]);
	useLayoutEffect(() => {
		if (placedRef.current || rows.length === 0) return;
		placedRef.current = true;
		if (!view.pinned && view.scroll > 0) virtualizer.scrollToOffset(view.scroll);
		else virtualizer.scrollToIndex(rows.length - 1, {align: "end"});
	}, [rows.length, view.pinned, view.scroll, viewing, virtualizer]);

	// …and after that, the transcript follows the newest turn only while it is already resting on
	// it. `totalSize` carries both cases the follow owes: a row appended, and the last row measuring
	// taller than the estimate — which lands a render late, because `useFlushSync: false` above
	// defers `measureElement`'s notification to React's own scheduling.
	useLayoutEffect(() => {
		if (!view.pinned || rows.length === 0) return;
		virtualizer.scrollToIndex(rows.length - 1, {align: "end"});
	}, [view.pinned, rows.length, totalSize, virtualizer]);

	const onScroll = useCallback(
		(event: UIEvent<HTMLDivElement>) => {
			const offset = event.currentTarget.scrollTop;
			// This event is the arrival of the offset `scrollToFn` above just asked for, so it is the
			// window hearing its own request rather than the reader moving. Both readings below are
			// about where the *reader* went — whether they left the newest turn, and whether they
			// reached the top asking for history — and neither is a question a scroll of the window's
			// own answers.
			const asked = selfScrollRef.current;
			selfScrollRef.current = null;
			const byReader = asked === null || Math.abs(offset - asked) > 1;
			// The pin is written on the transition and not through the debounce below: a turn landing
			// inside the settle window would otherwise read a pin the operator has already left.
			if (byReader) {
				const pinned = onNewest(event.currentTarget, totalSize, options.bottomThreshold);
				commit((current) => (current.pinned === pinned ? current : {...current, pinned}));
			}
			// The offset is where the transcript rests whoever moved it, so it is committed either way.
			// It is held on a ref as well as in this closure, because a swap has to be able to settle it
			// early — `settleScroll` above.
			restingAt.current = offset;
			if (commitTimer.current !== null) clearTimeout(commitTimer.current);
			commitTimer.current = setTimeout(() => {
				commitTimer.current = null;
				restingAt.current = null;
				commit((current) => (current.scroll === offset ? current : {...current, scroll: offset}));
			}, options.scrollCommitMs);
			if (byReader && offset <= options.topThreshold) requestOlder();
		},
		[
			commit,
			options.bottomThreshold,
			options.scrollCommitMs,
			options.topThreshold,
			requestOlder,
			totalSize,
		],
	);

	const phase = state?.phase ?? "idle";
	const models = state?.models ?? null;
	const commands = state?.commands ?? null;
	const thinking = state?.thinking ?? null;
	const composer = useMemo(
		() =>
			composerBridge({
				initialPhase: phase,
				initialModels: models ?? {current: null, available: []},
				initialCommands: commands ?? [],
				initialThinking: thinking ?? {current: null, available: []},
				// The draft clears and the text is held under the send's own key in the same commit:
				// the composer empties as it always did, and nothing is thrown away until the session
				// says the layer took it (#8005).
				onPrompt: (text) => {
					const key = options.newKey();
					dispatch({type: "prompt", text, key, timestamp: options.now()});
					// Sending is the operator asking for the answer, so the window re-pins: one who
					// scrolled up to read history and then typed sees their own turn and the reply.
					commit((current) => ({
						...current,
						draft: "",
						pinned: true,
						outgoing: holdSend(current.outgoing, {key, text}),
					}));
				},
				onInterrupt: () => dispatch({type: "interrupt", at: options.now()}),
				onSetModel: (model) => dispatch({type: "setModel", model}),
				onSetThinkingLevel: (level) => dispatch({type: "setThinkingLevel", level}),
			}),
		// `phase`, `models`, `commands` and `thinking` seed the bridge and are deliberately not
		// dependencies:
		// `AgentChatInput` re-runs its whole load on a new bridge identity, so a bridge rebuilt per
		// change would drop the composer back into `loading` on every turn. All four reach it
		// through the setters below.
		[dispatch, commit, options.newKey, options.now],
	);
	useEffect(() => composer.setPhase(phase), [composer, phase]);
	useEffect(() => {
		if (models !== null) composer.setModels(models);
	}, [composer, models]);
	useEffect(() => {
		if (commands !== null) composer.setCommands(commands);
	}, [composer, commands]);
	useEffect(() => {
		if (thinking !== null) composer.setThinking(thinking);
	}, [composer, thinking]);

	// A held send leaves this window on the session's word rather than on this window's own read of
	// what it dispatched: `sends` answers per idempotency key, so a refusal the other window earned
	// settles the other window's copy and never this one's (#8005).
	const sends = state?.sends ?? null;
	const held = useMemo(() => readHeld(view.outgoing, sends ?? []), [view.outgoing, sends]);

	useEffect(() => {
		if (held.landed.length === 0) return;
		commit((current) => ({
			...current,
			outgoing: current.outgoing.filter((send) => !held.landed.includes(send.key)),
		}));
	}, [held.landed, commit]);

	const restoreSend = useCallback(
		(key: string) =>
			commit((current) => {
				const saved = current.outgoing.find((send) => send.key === key);
				if (saved === undefined) return current;
				return {
					...current,
					draft: recoverInto(current.draft, saved.text),
					outgoing: dropSend(current.outgoing, key),
				};
			}),
		[commit],
	);

	const discardSend = useCallback(
		(key: string) => commit((current) => ({...current, outgoing: dropSend(current.outgoing, key)})),
		[commit],
	);

	const interruptedId = state?.interrupted ?? null;
	const interruption = state?.interruption ?? null;
	// The status line is time-dependent only while an abort is unanswered, and it changes exactly
	// once — when the grace runs out. So one timeout at that boundary re-renders it, rather than a
	// poll ticking for the whole turn.
	const [, passGrace] = useState(0);
	useEffect(() => {
		if (interruption === null) return;
		const remaining = interruption.requestedAt + interruptionGraceMillis - options.now();
		if (remaining <= 0) return;
		const timer = setTimeout(() => passGrace((count) => count + 1), remaining);
		return () => clearTimeout(timer);
	}, [interruption, options.now]);

	const lastPrompt = state?.lastPrompt ?? null;
	const resend = useCallback(() => {
		if (lastPrompt === null) return;
		dispatch({type: "prompt", text: lastPrompt, key: options.newKey(), timestamp: options.now()});
	}, [dispatch, lastPrompt, options.newKey, options.now]);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (event.defaultPrevented) return;
			// An armed prefix owns the next key from any focus, so the window's own two keys stand
			// down for it: `<prefix> r` is a shell reload, not a resend (#8270).
			if (prefixArmedAround(event.target)) return;
			if (event.key === "Escape" && isWorking(phase)) {
				event.preventDefault();
				dispatch({type: "interrupt", at: options.now()});
				return;
			}
			if (event.altKey && (event.key === "r" || event.key === "R") && interruptedId !== null) {
				event.preventDefault();
				resend();
			}
		},
		[dispatch, interruptedId, options.now, phase, resend],
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
		// The provider sits above the whole window, not just the composer: a design primitive the
		// transcript mounts (a table's scroller name) reads this catalog too, and the package's own
		// default is Turkish.
		<DesignTranslationProvider
			translate={viewing === null ? tuvalDesignTranslate : tuvalSubagentViewTranslate}
		>
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
						{statusLine({
							phase,
							failure: state?.failure ?? null,
							interruption,
							now: options.now(),
						})}
					</p>
					<div className="tuval-chat-bar-end">
						{options.extras === null ? null : options.extras(process.state)}
					</div>
				</div>
				{options.subagentList ? (
					<>
						<SubagentList
							ref={navigatorRef}
							slots={process.state.subagents}
							now={options.now}
							viewing={viewing?.id ?? null}
							onView={showSubagent}
							onMain={showMain}
						/>
						{/* The one live region for the view slot, and the reason the visible notice below is
						    not a second one. A `log` announces what is appended to it, so a swap — which
						    replaces the whole transcript under the reader — and a worker finishing under an
						    open view are both announced here or nowhere. */}
						<p className="kp-visually-hidden" role="status">
							{viewedSlot === undefined
								? viewing === null
									? "Showing the agent's own transcript."
									: "Showing a subagent whose transcript is not in this session's state."
								: viewedSlot.status === "finished"
									? `Showing the ${viewedSlot.type} subagent's transcript. Finished: ${viewedSlot.lastLine}`
									: `Showing the ${viewedSlot.type} subagent's transcript. Still running.`}
						</p>
					</>
				) : null}
				<div
					ref={scrollRef}
					className="tuval-chat-transcript"
					onScroll={onScroll}
					onKeyDown={swallowBareCharacter}
					role="log"
					data-view={viewing === null ? undefined : viewing.id}
					aria-label={
						viewedSlot === undefined ? "Transcript" : `Transcript: ${viewedSlot.type} subagent`
					}
					// The scroll container is the only way to older turns on a plain transcript, so a
					// keyboard user must be able to focus it (axe scrollable-region-focusable).
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must take keyboard focus
					tabIndex={0}
				>
					<div className="tuval-chat-spacer" style={{height: `${totalSize}px`}}>
						{virtualizer.getVirtualItems().map((virtual) => {
							const row = rows[virtual.index];
							if (row === undefined) return null;
							return (
								<div
									key={virtual.key}
									className="tuval-chat-row"
									data-index={virtual.index}
									data-kind={row.kind === "item" ? row.item.kind : row.kind}
									// Authorship as the row's shape carries it (#8210), and the hook the bubble and
									// prose rules in `chat.css` hang on.
									data-message-role={row.kind === "item" ? row.item.kind : undefined}
									data-nested={row.kind === "item" && row.nested ? "true" : undefined}
									ref={virtualizer.measureElement}
									style={{
										transform: `translateY(${virtual.start}px)`,
										// One indent step per fold the row sits inside, so a subagent's own subagent
										// reads as a further step in rather than as another row at the same level.
										...(row.kind === "item" && row.depth > 0 ? {"--nest-depth": row.depth} : {}),
									}}
								>
									<RowView
										row={row}
										interruptedId={interruptedId}
										onResend={lastPrompt === null ? null : resend}
										onOlder={requestOlder}
										expanded={expanded}
										unfolded={unfolded}
										onToggleRow={toggleRow}
										onToggleFold={toggleFold}
										// Only where the navigator is drawn: a jump into a worker's rows with
										// no list above them leaves the reader no way back out (#8405).
										onViewSubagent={options.subagentList ? showSubagent : null}
									/>
								</div>
							);
						})}
					</div>
				</div>
				{viewing === null ? null : (
					// Q9, verbatim: "we should show something to user if they are actually inside a
					// subagent that's already finished." The view stays open on the rows it had and says
					// so at the end of them; the way back is the navigator's first row, above. Not a live
					// region — the hidden one above carries this same sentence and announces it once.
					<p className="tuval-chat-subagent-end" data-status={viewedSlot?.status}>
						{viewedSlot === undefined ? (
							"This subagent's transcript is not in this session's state."
						) : viewedSlot.status === "finished" ? (
							<>
								<span className="tuval-chat-subagent-end-mark">finished</span>
								{viewedSlot.lastLine}
							</>
						) : (
							`The ${viewedSlot.type} subagent is still running.`
						)}
					</p>
				)}
				{isWorking(phase) ? (
					// Visual only. The phase line above is the announced surface for the running turn, so a
					// live region here would narrate that same turn twice; what this adds is the tell at
					// the end of the transcript, where the eye already is while a turn runs.
					<p className="tuval-chat-working" aria-hidden="true">
						<span className="tuval-chat-working-dots">
							<span />
							<span />
							<span />
						</span>
						{workingTell({
							phase,
							failure: state?.failure ?? null,
							interruption,
							now: options.now(),
						})}
					</p>
				) : null}
				<PermissionCards permissions={process.state.permissions} onAnswer={answerPermission} />
				<QueuedMessages queued={process.state.queued} />
				<UnsentMessages
					windowId={host.windowId}
					unsent={held.unsent}
					onRestore={restoreSend}
					onDiscard={discardSend}
				/>
				<AgentChatInput
					variant="focused"
					bridge={composer.bridge}
					// Founder ruling on #8466: while the view slot shows a subagent the composer is
					// disabled, not re-worded. A prompt typed here would land in the transcript the
					// operator is not reading, and there is no second session to address it to. It stays
					// mounted — the draft is the component's own state, so unmounting it would drop text
					// the swap must not touch — and the placeholder swapped above says why.
					disabled={viewing !== null}
					// The mode picker rides the composer's `settings` slot rather than the bridge: mode is
					// this window's vocabulary, and a bridge method would make every other implementor of
					// `AgentChatInputBridge` answer a question only this one has (#8190).
					settings={<ModeSwitch modes={process.state.modes} onSetMode={setMode} />}
					initialValue={view.draft}
					onDraftChange={(draft) =>
						commit((current) => (current.draft === draft ? current : {...current, draft}))
					}
				/>
			</section>
		</DesignTranslationProvider>
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
