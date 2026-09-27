/** @jsxRuntime automatic @jsxImportSource react */

/*
 * The pragma above is not decoration. esbuild — which is what Vite transforms this file with when
 * a desk serves it — reads its JSX setting off the nearest `tsconfig.json`, and here that is the
 * kernel lens, which excludes this file and declares no `jsx` at all. Without the pragma esbuild
 * falls back to the classic `React.createElement` transform and every render throws
 * `React is not defined`. `tsconfig.window.json` already says `react-jsx`; this line is that same
 * fact, where the bundler can see it.
 */

/**
 * A notifier, as a window: everything this one has sent, and a box to send another.
 *
 * **Why a window when there is already a tile.** The tile holds two derived lines, and the second
 * of them is a verdict — `delivered 07:00 · ok`. A verdict is not the thing a person came to read.
 * What went out *was* a morning brief, or a deploy line, or the message a full outbox refused; one
 * row per message, newest at the bottom, is the whole point of opening one. It reads as a chat
 * because that is what it is: a log of what this desk said to you, and a place to say something
 * back.
 *
 * **Both paths land in one log.** `:<id> send …` and a routed brief are the same arrival in the
 * same cell, so the history does not know which one it is looking at and neither does this window.
 * There is no "manual" section and no "automatic" one, because there is no such distinction in the
 * program.
 *
 * **The target is not here, and will not be.** A webhook URL and an ntfy topic are credentials, and
 * `./state.ts` is what a window is handed — so the heading says `notify · ntfy` and not one
 * character more about where a message went. The suite's "no secret is ever written down" cases
 * guard the record this file draws from; there is nothing for this file to leak.
 *
 * **What this module may import.** `@kampus/tuval-sdk/window` (the browser-safe door, whose own closure
 * reaches no `node:` builtin), `effect`, `react`, this package's kernel-free `./state.ts` and the
 * `./target.ts` types under it. It must not reach `./notify.ts` or `./deliver.ts`: the first
 * imports `@kampus/tuval-sdk/authoring`, which reaches `node:crypto` through the kernel, and the page
 * loads this module in a browser tab. `state.unit.test.ts` walks the imports and says so.
 *
 * **What the two exports are.** `default` is a renderer minted with `windowRenderer("module", …)`
 * and `admits` is the predicate over the state it reads — the contract the page's module loader
 * checks at boot, and a wrong export there is a named placeholder rather than a throw (ADR 0358,
 * ADR 0359).
 *
 * **Send is a dispatch, not a spell call.** `WindowHost` carries `readProcess`, `dispatch`, `view`
 * and `setView`, and no way to call a spell. That is not a gap here: `:<id> send <text>` is itself
 * a bare `send("message", asTurn(text))`, so the arrival the spell produces and the event this
 * composer dispatches are the same event landing in the same cell. The composer is the spell,
 * without the palette.
 */

import type {WindowHost} from "@kampus/tuval-sdk/window";
import {windowRenderer} from "@kampus/tuval-sdk/window";
import {Effect, Fiber, Stream} from "effect";
import type {CSSProperties, ReactElement} from "react";
import {useCallback, useEffect, useRef, useState} from "react";
import type {DeliveryView, NotifySendEvent, NotifyState, NotifyWindowView} from "./state.ts";
import {notifyView, sendEvent} from "./state.ts";

/** The predicate the page admits this renderer's state through (ADR 0358). */
export {isNotifyState as admits} from "./state.ts";

type NotifyHost = WindowHost<NotifyState, NotifySendEvent>;

/**
 * This process's public state, live. The stream never fails and ends on `ProcessGone`, so there is
 * no error arm: `null` is "nothing yet", and a gone process simply stops updating. The page mounts
 * this renderer only over a state `admits` returned true for, so the value is this program's own.
 */
const useNotifyState = (host: NotifyHost): NotifyState | null => {
	const [state, setState] = useState<NotifyState | null>(null);
	const read = host.readProcess;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(read, (view) =>
				Effect.sync(() => {
					if (view._tag === "Live") setState(view.state);
				}),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [read]);
	return state;
};

// Inline rather than a stylesheet: a `.css` import would make this module's build a second step and
// its package a second file, for a window that is a header, a list and a text box.
const styles = {
	root: {
		display: "flex",
		flexDirection: "column",
		gap: "0.75rem",
		padding: "0.75rem",
		font: "inherit",
		height: "100%",
		boxSizing: "border-box",
	},
	header: {display: "flex", flexDirection: "column", gap: "0.15rem"},
	heading: {fontWeight: 600},
	status: {opacity: 0.75},
	// The log scrolls and the composer does not, so the box a person types in stays put while the
	// conversation above it moves. `flex: 1` with `minHeight: 0` is what lets it actually shrink.
	log: {
		flex: 1,
		minHeight: 0,
		overflowY: "auto",
		listStyle: "none",
		margin: 0,
		padding: 0,
		display: "flex",
		flexDirection: "column",
		gap: "0.4rem",
	},
	item: {display: "flex", flexDirection: "column", gap: "0.1rem"},
	text: {whiteSpace: "pre-wrap", overflowWrap: "anywhere"},
	meta: {
		display: "flex",
		gap: "0.4rem",
		alignItems: "baseline",
		fontSize: "0.85em",
		opacity: 0.6,
	},
	at: {fontVariantNumeric: "tabular-nums"},
	// A failure is the one thing in this window worth finding by eye, so it is the one thing with a
	// colour. `ok` stays in the same grey as the clock beside it.
	failed: {opacity: 0.9, color: "#c0392b"},
	composer: {display: "flex", alignItems: "center", gap: "0.5rem"},
	input: {flex: 1, font: "inherit", padding: "0.25rem 0.4rem"},
	hint: {opacity: 0.6, fontSize: "0.85em"},
	empty: {opacity: 0.6},
} satisfies Record<string, CSSProperties>;

/** One message that went out: what it said, when, and how it ended. */
function Row({row}: {readonly row: DeliveryView}): ReactElement {
	return (
		<li style={styles.item}>
			<span style={styles.text}>{row.text}</span>
			<span style={styles.meta}>
				<span style={styles.at}>{row.at}</span>
				<span style={row.ok ? undefined : styles.failed}>{row.outcome}</span>
			</span>
		</li>
	);
}

/**
 * The log, plus the one message that has left and not been answered for. The in-flight row is drawn
 * at the bottom of the same list rather than beside it, because it is the newest thing that
 * happened and a reader should not have to look in two places for the order.
 *
 * **It opens at the bottom and stays there.** A chat whose newest row is the one you have to scroll
 * to find is not a chat: the list is ordered oldest-first, so a browser's default — top — is the
 * *least* interesting end of it, and a message sent from the composer would land off-screen. So the
 * effect below pins the scroll to the end whenever the number of rows moves or a message goes on or
 * off the wire.
 *
 * There is no JSX tier in this package's suite — no jsdom, no renderer — so this is not covered by
 * a case, and the manual expectation is stated here instead: open a notifier with more rows than
 * fit, and the newest is visible without scrolling; send from the composer, and the `sending…` row
 * it produces is visible without scrolling. Everything else in this window *is* a case, because
 * everything else is a pure function of state in `./state.ts`.
 */
function Log({view}: {readonly view: NotifyWindowView}): ReactElement {
	const list = useRef<HTMLUListElement | null>(null);
	/**
	 * What is at the end of the list right now, as a string — the whole of what the pin below depends
	 * on, and it is one value rather than two on purpose.
	 *
	 * A row's key carries both the delivery's clock and its place, so it moves when a message is
	 * added *and* when the oldest is dropped at the bound; the in-flight arm moves when a message
	 * goes on or off the wire, or when the next one takes the slot. Depending on `view.sending`
	 * itself would be wrong twice over — `notifyView` builds a fresh record every render, and the
	 * effect does not read the record.
	 */
	const tail =
		view.sending === null ? (view.log.at(-1)?.key ?? "") : `sending:${view.sending.text}`;
	useEffect(() => {
		const node = list.current;
		// Null on the render where the log is empty, because that arm draws a `<p>` and not a `<ul>`,
		// which is also the one case where `tail` is the empty string.
		if (node === null || tail === "") return;
		node.scrollTop = node.scrollHeight;
	}, [tail]);

	if (view.log.length === 0 && view.sending === null) {
		return <p style={styles.empty}>{view.empty}</p>;
	}
	return (
		<ul ref={list} style={styles.log}>
			{view.log.map((row) => (
				<Row key={row.key} row={row} />
			))}
			{view.sending === null ? null : (
				<li style={styles.item}>
					<span style={styles.text}>{view.sending.text}</span>
					<span style={styles.meta}>
						<span>sending…</span>
						{view.sending.waiting === 0 ? null : (
							<span>{view.sending.waiting} waiting behind it</span>
						)}
					</span>
				</li>
			)}
		</ul>
	);
}

/**
 * The window over one live notifier. Everything it draws comes from `notifyView`, which is pure and
 * tested on its own; this component decides nothing but where the lines go and what the box holds
 * before it is sent.
 */
function NotifyWindow({host}: {readonly host: NotifyHost}): ReactElement {
	const state = useNotifyState(host);
	const [draft, setDraft] = useState("");
	const send = useCallback(() => {
		const text = draft.trim();
		// Empty does nothing — not a refusal, not a record, nothing. There is no message here to send,
		// and a notifier that posted a blank line to your phone on a stray Enter would be a bad one.
		if (text === "") return;
		void Effect.runFork(host.dispatch(sendEvent(text)));
		setDraft("");
	}, [host, draft]);

	if (state === null) {
		return <output style={styles.empty}>Waiting for the first state from this notifier.</output>;
	}
	const view = notifyView(state);
	return (
		<section style={styles.root} aria-label={`notifier ${view.heading}`}>
			<header style={styles.header}>
				<span style={styles.heading}>{view.heading}</span>
				<span style={styles.status}>{view.status}</span>
			</header>
			<Log view={view} />
			<div style={styles.composer}>
				<input
					type="text"
					style={styles.input}
					value={draft}
					placeholder="a line to send"
					aria-label="message to send"
					onChange={(change) => setDraft(change.target.value)}
					onKeyDown={(key) => {
						if (key.key === "Enter") send();
					}}
				/>
				<button type="button" onClick={send}>
					Send
				</button>
			</div>
			<span style={styles.hint}>same as {view.spell}</span>
		</section>
	);
}

/**
 * The contract a `kind: "module"` reference names. `windowRenderer` comes from the door rather than
 * being a hand-written `{kind, render}`, so the page's kind check (`module`, not `host-native`) is
 * satisfied by construction and not by a literal that could drift.
 */
export default windowRenderer("module", (host: NotifyHost) => <NotifyWindow host={host} />);
