/**
 * The subagent navigator at the top of the agent window (#8405, #8406, #8407).
 *
 * Rendered off the port's subagent slot alone, so every agent program gets it the moment its
 * mapper fills the slot — nothing here names a backend. Absent rather than empty when nothing is
 * running and the window is on main (Q4, the founder: "my screen should only show me enough info,
 * not more"), which is why this returns `null` instead of an empty region.
 *
 * It is a navigator and not a readout (Q8): each row is a real button that swaps the window's one
 * view slot onto that worker's transcript, and inside a subagent view a leading row swaps back to
 * the agent's own. Both reach with mouse and keyboard alike, which was Q4's other half — and the
 * keyboard reaches them through *these* handlers, the ones the mouse calls, never through a second
 * copy that could drift.
 *
 * A kernel child is the one row that does something else: it is a process of its own, so it is
 * marked as one and activating it opens it as a window rather than swapping this window's view
 * (founder rulings R1.1 and R2.1 on #8715). Its rows are not in this session's state and there is
 * nothing here to swap to.
 *
 * The list holds one tab stop, not one per row: `<c-b> a` puts focus on the row the window is
 * showing (`focus()` below, driven by the shell's forwarded key), and the arrows walk from there.
 * Which row holds the stop is component state and never the view slot — where DOM focus sits is not
 * a fact a checkpoint should restore.
 *
 * Elapsed is the one thing the list computes rather than reads. It ticks on a timer that moves a
 * render counter and nothing else: a per-second `Msg` would checkpoint the whole session once a
 * second per running worker, and a per-second view write would do the same to this window's slot.
 */

import {MetaRow} from "@kampus/design";
import type {ReactElement, KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref} from "react";
import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {SubagentSlot} from "../../ai-agent/ports/index.ts";
import {prefixArmedAround} from "../window/index.ts";
import {workerCountLabel} from "./copy.ts";
import {
	elapsedLabel,
	runningSubagents,
	SUBAGENT_ROW_CAP,
	type SubagentRow,
	tokenLabel,
} from "./subagents.ts";

/** How often the elapsed readouts are re-rendered. One second: the coarsest unit the label shows. */
const TICK_MS = 1_000;

/** How the window drives the list from outside it — the chord's landing point, and nothing else. */
export interface SubagentListHandle {
	/** Put DOM focus on the row holding the tab stop. `false` when there is no list to focus. */
	readonly focus: () => boolean;
}

/**
 * One focusable line, in the order they are drawn. The key is prefixed rather than the bare id
 * because a worker's id is a transcript item id and could spell either of the other two.
 */
type Entry =
	| {readonly kind: "main"; readonly key: string}
	| {readonly kind: "row"; readonly key: string; readonly row: SubagentRow}
	| {readonly kind: "more"; readonly key: string; readonly count: number};

/** Which line to put focus on once the entries have changed under an activation. */
type FocusRequest = {readonly kind: "first"} | {readonly kind: "key"; readonly key: string};

const rowKey = (id: string): string => `row:${id}`;

function Line({
	entryKey,
	current,
	stop,
	register,
	onPick,
	className,
	children,
}: {
	readonly entryKey: string;
	readonly current?: boolean;
	/** This line holds the list's one tab stop. Every other line is reachable by arrow alone. */
	readonly stop: boolean;
	readonly register: (key: string, node: HTMLButtonElement | null) => void;
	readonly onPick: () => void;
	readonly className?: string;
	readonly children: ReactNode;
}): ReactElement {
	return (
		<li className="tuval-chat-subagent-item">
			<button
				type="button"
				className={className ?? "tuval-chat-subagent-pick"}
				ref={(node) => {
					register(entryKey, node);
				}}
				// The row that is showing is marked rather than disabled: a disabled control drops out
				// of the tab order, so the operator's place in the navigator would vanish under them.
				aria-current={current === true ? "true" : undefined}
				tabIndex={stop ? 0 : -1}
				onClick={onPick}
			>
				{children}
			</button>
		</li>
	);
}

function RowFields({row, at}: {readonly row: SubagentRow; readonly at: number}): ReactElement {
	const kernel = row.process !== undefined;
	const workers = workerCountLabel(row.workers);
	return (
		<MetaRow as="span" className="tuval-chat-subagent">
			{/* A row whose worker named itself nothing draws no name field — and no dot for one. */}
			{row.type === null ? null : (
				<>
					<span className="tuval-chat-subagent-type" data-field="type">
						{row.type}
					</span>
					<MetaRow.Dot />
				</>
			)}
			{/* The count sits beside the name, because it qualifies whose line and spend follow it. */}
			{workers === null ? null : (
				<>
					<span className="tuval-chat-subagent-workers" data-field="workers">
						{workers}
					</span>
					<MetaRow.Dot />
				</>
			)}
			{/* The mark is the word, not a colour and not an icon: a reader who cannot see the
			    styling still reads "process", and the hidden half says what activating it does —
			    which is the one thing this row does differently from every other (Pillar 4). */}
			{kernel ? (
				<>
					<span className="tuval-chat-subagent-kernel" data-field="kernel">
						process
						<span className="kp-visually-hidden"> — opens in its own window</span>
					</span>
					<MetaRow.Dot />
				</>
			) : null}
			<span className="tuval-chat-subagent-line" data-field="line">
				{row.lastLine}
			</span>
			{kernel ? (
				<>
					<MetaRow.Dot />
					{/* No token count: this session spawned the process and writes none of its lines,
					    so it knows nothing of what the child spends. */}
					<span data-field="elapsed">
						<span className="kp-visually-hidden">elapsed </span>
						{elapsedLabel(at - row.startedAt)}
					</span>
				</>
			) : row.status === "finished" ? (
				<>
					<MetaRow.Dot />
					{/* Q2: no elapsed and no token readout once a worker stops. */}
					<span data-field="status">finished</span>
				</>
			) : (
				<>
					<MetaRow.Dot />
					<span data-field="elapsed">
						{/* The unit is what the number means, and the layout is the only thing saying it. */}
						<span className="kp-visually-hidden">elapsed </span>
						{elapsedLabel(at - row.startedAt)}
					</span>
					<MetaRow.Dot />
					<span data-field="tokens">
						{tokenLabel(row.tokens)}
						<span className="kp-visually-hidden"> tokens</span>
					</span>
				</>
			)}
		</MetaRow>
	);
}

export function SubagentList({
	slots,
	now,
	viewing,
	onView,
	onOpen,
	onMain,
	ref,
}: {
	readonly slots: Readonly<Record<string, SubagentSlot>>;
	readonly now: () => number;
	/** The subagent whose transcript the window is showing, or `null` for the agent's own. */
	readonly viewing: string | null;
	readonly onView: (id: string) => void;
	/** Open a kernel child as its own window. Only a row naming a process ever reaches it. */
	readonly onOpen: (processId: string) => void;
	readonly onMain: () => void;
	readonly ref?: Ref<SubagentListHandle>;
}): ReactElement | null {
	const [showAll, setShowAll] = useState(false);
	const [held, setHeld] = useState<string | null>(null);
	const [request, setRequest] = useState<FocusRequest | null>(null);
	const nodes = useRef(new Map<string, HTMLButtonElement>());

	const model = useMemo(
		() => runningSubagents(slots, viewing, showAll ? Number.POSITIVE_INFINITY : SUBAGENT_ROW_CAP),
		[slots, viewing, showAll],
	);
	const running = model.rows.filter((row) => row.status === "running").length;

	const entries = useMemo((): ReadonlyArray<Entry> => {
		const rows = model.rows.map((row): Entry => ({kind: "row", key: rowKey(row.id), row}));
		return [
			...(viewing === null ? [] : [{kind: "main", key: "main"} as const]),
			...rows,
			...(model.more <= 0 ? [] : [{kind: "more", key: "more", count: model.more} as const]),
		];
	}, [model, viewing]);
	const keys = useMemo(() => entries.map((entry) => entry.key), [entries]);

	// Where the stop rests by default: the row the window is showing, so the chord lands on the
	// operator's own place in the navigator rather than at the top of a list they have walked past.
	const fallback =
		entries.find((entry) => entry.kind === "row" && entry.row.current)?.key ?? keys[0];
	const stop = held !== null && keys.includes(held) ? held : fallback;

	const register = useCallback((key: string, node: HTMLButtonElement | null) => {
		if (node === null) nodes.current.delete(key);
		else nodes.current.set(key, node);
	}, []);

	const moveTo = useCallback((key: string | undefined) => {
		if (key === undefined) return false;
		setHeld(key);
		const node = nodes.current.get(key);
		if (node === undefined) return false;
		node.focus();
		return true;
	}, []);

	useImperativeHandle(ref, () => ({focus: () => moveTo(stop)}), [moveTo, stop]);

	// The counter's value is never read: setting it is the re-render, and the re-render is the tick.
	const [, tick] = useState(0);
	useEffect(() => {
		if (running === 0) return;
		const timer = setInterval(() => tick((count) => count + 1), TICK_MS);
		return () => clearInterval(timer);
	}, [running]);

	/**
	 * A line that took the focus and then removed itself — the "more" row — would drop focus onto
	 * the body, which is where a keyboard operator loses the list entirely. So an activation that
	 * changes the entries names where focus goes next, and this places it once the new entries are
	 * drawn.
	 *
	 * The way back is not one of them any more: leaving a view can take the whole region with it
	 * (the last finished worker), so its destination is the window's composer and the window places
	 * it (`ChatWindow.tsx`, founder ruling 2026-09-08 on #8470).
	 */
	useLayoutEffect(() => {
		if (request === null) return;
		setRequest(null);
		moveTo(request.kind === "key" && keys.includes(request.key) ? request.key : keys[0]);
	}, [request, keys, moveTo]);

	/**
	 * What activating a row does, which is the one thing the two kinds of row do differently: a
	 * kernel child is a process of its own and opens as a window, where a worker's rows live inside
	 * this session and swap the window's view slot (founder rulings R1.1 and R2.1 on #8715). The
	 * keyboard reaches both through this one handler, the one the mouse calls.
	 */
	const pickRow = useCallback(
		(row: SubagentRow) => {
			setHeld(rowKey(row.id));
			if (row.process === undefined) onView(row.id);
			else onOpen(row.process);
		},
		[onView, onOpen],
	);

	const expand = useCallback(() => {
		const first = runningSubagents(slots, viewing, Number.POSITIVE_INFINITY).rows[SUBAGENT_ROW_CAP];
		setShowAll(true);
		setRequest(first === undefined ? {kind: "first"} : {kind: "key", key: rowKey(first.id)});
	}, [slots, viewing]);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLUListElement>) => {
			if (event.defaultPrevented) return;
			// An armed prefix owns the next key from any focus, so the list stands down for it:
			// `<prefix> <arrowdown>` is the shell walking windows, not this list walking rows (#8270).
			if (prefixArmedAround(event.target)) return;
			const step = (to: number): void => {
				const key = keys[Math.min(Math.max(to, 0), keys.length - 1)];
				if (key === undefined) return;
				event.preventDefault();
				// Swallowed here, so the desk's one listener never routes it and no second copy of this
				// key comes back forwarded — which would walk the list twice per press.
				event.stopPropagation();
				moveTo(key);
			};
			const at = stop === undefined ? -1 : keys.indexOf(stop);
			switch (event.key) {
				case "ArrowDown":
					return step(at + 1);
				case "ArrowUp":
					return step(at - 1);
				case "Home":
					return step(0);
				case "End":
					return step(keys.length - 1);
				case "Escape":
					// Only while there is somewhere to come back from. On main, Escape is the window's —
					// it interrupts a running turn — and taking it here would swallow that.
					if (viewing === null) return;
					event.preventDefault();
					event.stopPropagation();
					return onMain();
				default:
					return;
			}
		},
		[keys, moveTo, onMain, stop, viewing],
	);

	// A subagent view always draws the region, even with nothing to list: the way back is in it, and
	// a slot that has gone from state must not take the operator's exit with it.
	if (model.rows.length === 0 && viewing === null) return null;
	const at = now();
	return (
		<ul
			className="tuval-chat-subagents"
			// On main the region is what it says: the workers running right now. In a subagent view it
			// also carries the way back and, under Q9, a worker that has stopped — so it is named for
			// what it is there instead.
			aria-label={viewing === null ? "Running subagents" : "Subagents"}
			onKeyDown={onKeyDown}
		>
			{entries.map((entry) => {
				if (entry.kind === "main") {
					return (
						<Line
							key={entry.key}
							entryKey={entry.key}
							stop={stop === entry.key}
							register={register}
							onPick={onMain}
						>
							<MetaRow as="span" className="tuval-chat-subagent">
								Back to the agent transcript
							</MetaRow>
						</Line>
					);
				}
				if (entry.kind === "row") {
					return (
						<Line
							key={entry.key}
							entryKey={entry.key}
							current={entry.row.current}
							stop={stop === entry.key}
							register={register}
							onPick={() => pickRow(entry.row)}
						>
							<RowFields row={entry.row} at={at} />
						</Line>
					);
				}
				return (
					<Line
						key={entry.key}
						entryKey={entry.key}
						stop={stop === entry.key}
						register={register}
						onPick={expand}
						className="tuval-chat-subagent-pick tuval-chat-subagent-more"
					>
						{/* The name says what the control does and still contains its visible text. */}
						<span className="kp-visually-hidden">Show </span>
						{entry.count} more running
					</Line>
				);
			})}
		</ul>
	);
}
