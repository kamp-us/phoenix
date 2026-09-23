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
 * A cron, as a window: the schedule, what it is doing, and every brief it has come back with.
 *
 * **Why a window at all when there is already a tile.** The tile holds two derived lines — the
 * title and the status — and a run's `summary` is the thing a morning brief actually *is*. One line
 * per run, ten runs, read at a glance, is the whole point of opening one.
 *
 * **What this module may import.** `@kampus/tuval-sdk/window` (the browser-safe door, whose own closure
 * reaches no `node:` builtin), `effect`, `react`, and this package's kernel-free `./state.ts`. It
 * must not reach `./cron.ts`: that file imports `@kampus/tuval-sdk/authoring`, which reaches
 * `node:crypto` through the kernel, and the page loads this module in a browser tab.
 *
 * **What the two exports are.** `default` is a renderer minted with `windowRenderer("module", …)`
 * and `admits` is the predicate over the state it reads — the contract the page's module loader
 * checks at boot, and a wrong export there is a named placeholder rather than a throw (ADR 0359).
 *
 * **"Run now" is a dispatch, not a spell call.** `WindowHost` carries `readProcess`, `dispatch`,
 * `view` and `setView`, and no way to call a spell. That is not a gap here: `:<id> run` is itself a
 * bare `send("run", …)`, so the arrival the spell produces and the event this button dispatches are
 * the same event landing in the same cell. The button is the spell, without the palette.
 */

import type {WindowHost} from "@kampus/tuval-sdk/window";
import {windowRenderer} from "@kampus/tuval-sdk/window";
import {Effect, Fiber, Stream} from "effect";
import type {CSSProperties, ReactElement} from "react";
import {useCallback, useEffect, useState} from "react";
import type {CronRunEvent, CronState, CronWindowView} from "./state.ts";
import {cronView, runEvent} from "./state.ts";

/** The predicate the page admits this renderer's state through (ADR 0358). */
export {isCronState as admits} from "./state.ts";

type CronHost = WindowHost<CronState, CronRunEvent>;

/**
 * This process's public state, live. The stream never fails and ends on `ProcessGone`, so there is
 * no error arm: `null` is "nothing yet", and a gone process simply stops updating. The page mounts
 * this renderer only over a state `admits` returned true for, so the value is this program's own.
 */
const useCronState = (host: CronHost): CronState | null => {
	const [state, setState] = useState<CronState | null>(null);
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
// its package a second file, for a window that is four boxes and a list.
const styles = {
	root: {
		display: "flex",
		flexDirection: "column",
		gap: "0.75rem",
		padding: "0.75rem",
		font: "inherit",
		height: "100%",
		boxSizing: "border-box",
		overflow: "auto",
	},
	header: {display: "flex", flexDirection: "column", gap: "0.15rem"},
	cadence: {fontWeight: 600},
	status: {opacity: 0.75},
	controls: {display: "flex", alignItems: "center", gap: "0.5rem"},
	hint: {opacity: 0.6, fontSize: "0.85em"},
	list: {
		listStyle: "none",
		margin: 0,
		padding: 0,
		display: "flex",
		flexDirection: "column",
		gap: "0.5rem",
	},
	item: {display: "flex", gap: "0.5rem", alignItems: "baseline"},
	at: {opacity: 0.6, fontVariantNumeric: "tabular-nums", flex: "none"},
	verdict: {flex: "none"},
	summary: {whiteSpace: "pre-wrap", overflowWrap: "anywhere"},
	empty: {opacity: 0.6},
} satisfies Record<string, CSSProperties>;

function RunList({view}: {readonly view: CronWindowView}): ReactElement {
	if (view.runs.length === 0) {
		return <p style={styles.empty}>{view.emptyHistory}</p>;
	}
	return (
		<ul style={styles.list}>
			{view.runs.map((run) => (
				<li key={run.key} style={styles.item}>
					<span style={styles.at}>{run.at}</span>
					<span style={styles.verdict}>{run.ok ? "ok" : "failed"}</span>
					<span style={styles.summary}>{run.summary}</span>
				</li>
			))}
		</ul>
	);
}

/**
 * The window over one live cron. Everything it draws comes from `cronView`, which is pure and
 * tested on its own; this component decides nothing but where the lines go.
 */
function CronWindow({host}: {readonly host: CronHost}): ReactElement {
	const state = useCronState(host);
	const runNow = useCallback(() => {
		void Effect.runFork(host.dispatch(runEvent()));
	}, [host]);

	if (state === null) {
		return <output style={styles.empty}>Waiting for the first state from this cron.</output>;
	}
	const view = cronView(state);
	return (
		<section style={styles.root} aria-label={`cron ${view.id}`}>
			<header style={styles.header}>
				<span style={styles.cadence}>{view.cadence}</span>
				<span style={styles.status}>{view.status}</span>
			</header>
			<div style={styles.controls}>
				<button type="button" onClick={runNow} disabled={view.running}>
					Run now
				</button>
				<span style={styles.hint}>
					{view.running
						? "A run is already up — a wake mid-run is dropped."
						: `same as ${view.spell}`}
				</span>
			</div>
			<RunList view={view} />
		</section>
	);
}

/**
 * The contract a `kind: "module"` reference names. `windowRenderer` comes from the door rather than
 * being a hand-written `{kind, render}`, so the page's kind check (`module`, not `host-native`) is
 * satisfied by construction and not by a literal that could drift.
 */
export default windowRenderer("module", (host: CronHost) => <CronWindow host={host} />);
