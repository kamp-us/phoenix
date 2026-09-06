/**
 * The page's renderer table. The table lives here and not on the program row because a row is
 * kernel-side data that must stay free of React.
 *
 * It is keyed by the `RendererRef.ref` a program row declares, and the kernel sends that reference
 * over the registry frame (`../shell/transport/wire.ts`, #7788). So a program names its own renderer
 * and this table answers by name: a fourth windowed program that reuses one of these references
 * needs no edit here, and a reference nothing answers is a placeholder in the window rather than a
 * missing entry nobody can see.
 *
 * The two demo renderers below are the demo programs' (#7517). Each reads its process through the
 * window contract's `readProcess` and nothing else: no store, no fetch, no socket.
 *
 * The Pi entry is `PiChatWindow` (#7611), the Claude entry is `ClaudeChatWindow` (#7624) and the
 * session-list entry is `SessionListWindow` (#8102). They are why this module is out of the
 * kernel's strict lens and inside `tsconfig.design.json`'s: each is built on `@kampus/design`,
 * which is source-consumed and authored with
 * `exactOptionalPropertyTypes: false`. Each key is the reference that program's own row declares,
 * imported rather than retyped, so a row and this table cannot name two different renderers.
 */

import {Effect, Fiber, Stream} from "effect";
import type {ReactElement} from "react";
import {useEffect, useState} from "react";
import {isAiAgentSessionState} from "../ai-agent/core/snapshot.ts";
import {isSessionListState} from "../ai-agent/renderer-ref.ts";
import {
	AI_AGENT_INSPECTOR_REF,
	AiAgentInspector,
	SESSION_LIST_WINDOW_REF,
	SessionListWindow,
} from "../ai-agent/window/index.ts";
import {CLAUDE_CHAT_WINDOW_REF, ClaudeChatWindow} from "../claude/window/index.ts";
import {type CounterState, isCounterState} from "../demo/counter.ts";
import {isLogState, type LogState} from "../demo/log.ts";
import {PI_CHAT_WINDOW_REF, PiChatWindow} from "../pi/window/index.ts";
import type {AnyInspectorRenderer} from "../shell/desk/index.ts";
import type {WindowHost} from "../shell/window/index.ts";
import {windowRenderer} from "../shell/window/index.ts";
import {Pending, type ReadableRenderer, readsState} from "./readable-state.tsx";

/**
 * One process's public state, live. The stream never fails and ends on `ProcessGone`, so the hook
 * needs no error arm: `null` means "nothing yet", and a gone process simply stops updating.
 *
 * There is no cast here any more. The host arrives typed at the program's own state because the
 * table below binds every renderer to that program's predicate (`./readable-state.tsx`), and the
 * renderer is mounted only over a state the predicate admitted (#8157).
 */
const useProcessState = <S,>(host: WindowHost<S>): S | null => {
	const [state, setState] = useState<S | null>(null);
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

function CounterRenderer({host}: {readonly host: WindowHost<CounterState>}): ReactElement {
	const state = useProcessState(host);
	if (state === null) return <Pending />;
	return (
		<div className="tuval-demo">
			<p>
				<span className="tuval-demo-label">count</span>{" "}
				<output aria-label="Counter value">{state.count}</output>
			</p>
			<p className="tuval-demo-hint">Any key while this window has focus counts one more.</p>
		</div>
	);
}

function LogRenderer({host}: {readonly host: WindowHost<LogState>}): ReactElement {
	const state = useProcessState(host);
	if (state === null) return <Pending />;
	const rows = [
		...state.lines.map((count) => `count ${count}`),
		...state.keys.map((key) => `key ${key}`),
	];
	return (
		<div className="tuval-demo">
			{rows.length === 0 ? (
				<p className="tuval-demo-hint">Nothing logged yet.</p>
			) : (
				<ol className="tuval-demo-lines" aria-label="Log lines">
					{rows.map((row, index) => (
						<li key={`${row}-${index}`}>{row}</li>
					))}
				</ol>
			)}
		</div>
	);
}

/**
 * Every renderer the page knows, by the reference a program row names it with — each bound to the
 * predicate over the state it reads, which is what the `ReadableRenderer` type asks for. A renderer
 * put here unguarded does not typecheck, so the rule holds at the table and not by review (#8157).
 */
export const pageRenderers: Readonly<Record<string, ReadableRenderer>> = {
	"tuval/demo/counter": readsState(
		isCounterState,
		windowRenderer("host-native", (host: WindowHost<CounterState>) => (
			<CounterRenderer host={host} />
		)),
	),
	"tuval/demo/log": readsState(
		isLogState,
		windowRenderer("host-native", (host: WindowHost<LogState>) => <LogRenderer host={host} />),
	),
	[PI_CHAT_WINDOW_REF.ref]: readsState(isAiAgentSessionState, PiChatWindow),
	[CLAUDE_CHAT_WINDOW_REF.ref]: readsState(isAiAgentSessionState, ClaudeChatWindow),
	[SESSION_LIST_WINDOW_REF.ref]: readsState(isSessionListState, SessionListWindow),
};

/**
 * Every desk-inspector renderer the page knows, by the reference a program row names it with. It is
 * a second table rather than an arm of the one above because the desk region resolves through
 * `inspectorFor` and mounts an `InspectorRenderer`, which is a different type from a window
 * renderer and reaches the region by a different walk (`../shell/desk/compose.ts`).
 *
 * There is no `readsState` guard here: the admission wrapper is for a *window* renderer, and this
 * renderer performs the same check itself at the one place it reads
 * (`../ai-agent/window/AiAgentInspector.tsx`).
 *
 * Without this table `AttachedDesk` takes its empty default, the walk ends at `unknown-ref` and the
 * region shows a sentence in the running page whatever a row declares — which is what #8218 left
 * behind and this issue's ruling needs filled.
 */
export const pageInspectors: Readonly<Record<string, AnyInspectorRenderer>> = {
	[AI_AGENT_INSPECTOR_REF.ref]: AiAgentInspector,
};
