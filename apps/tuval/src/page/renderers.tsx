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
 * The Pi entry is `piChatWindow` (#7611), the Claude entry is `claudeChatWindow` (#7624) and the
 * session-list entry is `SessionListWindow` (#8102). Both chat entries are *built* here rather than
 * imported as their modules' default constants, because each is built at the operator's feature
 * flags (`chatOptions` below, #8439). They are why this module is out of the
 * kernel's strict lens and inside `tsconfig.design.json`'s: each is built on `@kampus/design`,
 * which is source-consumed and authored with
 * `exactOptionalPropertyTypes: false`. Each key is the reference that program's own row declares,
 * imported rather than retyped, so a row and this table cannot name two different renderers.
 *
 * The table is built per socket rather than held as a constant, because the session-list entry is
 * the one renderer that asks the kernel something: it is bound to this page's `call`, so the answer
 * it renders came over the socket the desk is attached to and dies with it (#8161).
 */

import features from "virtual:tuval/features";
import {Effect, Fiber, Stream} from "effect";
import type {ReactElement} from "react";
import {useCallback, useEffect, useRef, useState} from "react";
import {isAiAgentSessionState} from "../ai-agent/core/snapshot.ts";
import {isSessionListState} from "../ai-agent/renderer-ref.ts";
import {
	AI_AGENT_INSPECTOR_REF,
	AiAgentInspector,
	SESSION_LIST_WINDOW_REF,
	type SessionListSource,
	sessionListWindow,
	type TranscriptSource,
} from "../ai-agent/window/index.ts";
import {CLAUDE_CHAT_WINDOW_REF, claudeChatWindow} from "../claude/window/index.ts";
import {type CounterState, isCounterState} from "../demo/counter.ts";
import {isLogState, type LogState} from "../demo/log.ts";
import {PI_CHAT_WINDOW_REF, piChatWindow} from "../pi/window/index.ts";
import type {ThinChatWindowOptions} from "../shell/chat/index.ts";
import type {AnyInspectorRenderer} from "../shell/desk/index.ts";
import type {PageAttachment} from "../shell/transport/browser.ts";
import type {WindowHost} from "../shell/window/index.ts";
import {windowRenderer} from "../shell/window/index.ts";
import {Pending, type ReadableRenderer, readsState} from "./readable-state.tsx";
import {
	reading,
	readSessionList,
	type SessionListAnswer,
	sessionListCall,
	settled,
} from "./session-list.ts";
import {
	askedOlder,
	landedPage,
	noPages,
	pagedAnswer,
	readSessionTranscript,
	sessionTranscriptCall,
} from "./session-transcript.ts";

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

/** How this page asks the kernel one thing: its socket's own `call` (`../shell/transport/client.ts`). */
export type SpellCaller = PageAttachment["call"];

/**
 * The session list, read from the kernel. One call per attempt, sent when the window mounts and
 * matched to its reply by the `CallId` it minted, so two open pickers never read each other's answer
 * (`./session-list.ts`). A socket that goes away is no answer at all: the read stays out until its
 * deadline passes, and the desk's own connection banner is what says the link is gone.
 *
 * Retry is the second correlation, and the attempt number is what carries it: a superseded call's
 * reply still passes the `CallId` check for the call *it* answered, so the landing is refused unless
 * the attempt it was sent for is still the current one (#8280).
 */
const sessionListSource = (call: SpellCaller): SessionListSource => {
	const useSessionListAnswer: SessionListSource = (window) => {
		const [attempt, setAttempt] = useState(0);
		const [startedAt, setStartedAt] = useState(() => Date.now());
		const [landed, setLanded] = useState<{
			readonly attempt: number;
			readonly answer: SessionListAnswer;
		} | null>(null);

		useEffect(() => {
			const spell = sessionListCall(window);
			const fiber = Effect.runFork(
				call(spell).pipe(
					Effect.flatMap((reply) =>
						Effect.sync(() => {
							const read = readSessionList(spell, reply);
							if (read !== null) setLanded({attempt, answer: read});
						}),
					),
					Effect.catchCause(() => Effect.void),
				),
			);
			return () => void Effect.runFork(Fiber.interrupt(fiber));
		}, [call, window, attempt]);

		const retry = useCallback(() => {
			setLanded(null);
			setStartedAt(Date.now());
			setAttempt((current) => current + 1);
		}, []);

		const answer = landed !== null && landed.attempt === attempt ? landed.answer : null;
		return {
			status: answer === null ? reading(startedAt) : settled(answer),
			retry,
		};
	};
	return useSessionListAnswer;
};

/**
 * One session's transcript, read from the kernel a page at a time. The first page leaves when the
 * transcript mounts and every later one leaves when the operator asks for older history, each
 * correlated on the `CallId` it minted (`./session-transcript.ts`) so a reply belonging to another
 * call — the list's, the other window's, the page this one superseded — is never folded in.
 *
 * **The cursor is what a request is, and the attempt is what makes it a new one.** A page that
 * lands moves the cursor; a page that fails does not, so asking again asks for the same page rather
 * than skipping the history that did not arrive. Two consecutive requests can therefore carry the
 * same cursor, which is why the attempt counter is in the dependencies: without it a retry would be
 * an effect whose inputs did not change and no call would leave.
 *
 * **Nothing here outlives the session it was opened for.** The whole state is this hook's, the hook
 * is mounted per selected session by the window (`../ai-agent/window/SessionListWindow.tsx`), and a
 * reply that lands after the read it belongs to was superseded is dropped rather than folded.
 */
const sessionTranscriptSource = (call: SpellCaller): TranscriptSource => {
	const useSessionTranscript: TranscriptSource = (request, window) => {
		const [paging, setPaging] = useState(noPages);
		const [cursor, setCursor] = useState<string | null>(null);
		const [attempt, setAttempt] = useState(0);
		const reading = useRef(false);

		useEffect(() => {
			if (request._tag !== "Read") return;
			let current = true;
			reading.current = true;
			const spell = sessionTranscriptCall({...request.read, before: cursor}, window);
			const fiber = Effect.runFork(
				call(spell).pipe(
					Effect.flatMap((reply) =>
						Effect.sync(() => {
							if (!current) return;
							const landing = readSessionTranscript(spell, reply);
							if (landing !== null) {
								reading.current = false;
								setPaging((held) => landedPage(held, cursor, landing));
							}
						}),
					),
					Effect.catchTag("SocketError", () =>
						Effect.sync(() => {
							if (!current) return;
							reading.current = false;
							setPaging((held) =>
								landedPage(held, cursor, {
									_tag: "Refused",
									failure: {
										tag: "tuval/TranscriptReadFailed",
										message: "This transcript page could not be read. You can try it again.",
									},
								}),
							);
						}),
					),
				),
			);
			return () => {
				current = false;
				void Effect.runFork(Fiber.interrupt(fiber));
			};
		}, [call, request, window, cursor, attempt]);

		const next = paging.next;
		const olderOut = paging.older._tag === "Reading";
		const older = useCallback(() => {
			if (next === null || olderOut || reading.current) return;
			reading.current = true;
			setPaging(askedOlder);
			setCursor(next);
			setAttempt((current) => current + 1);
		}, [next, olderOut]);

		const retry = useCallback(() => {
			if (paging.refusal === null || reading.current) return;
			reading.current = true;
			setPaging(noPages);
			setCursor(null);
			setAttempt((current) => current + 1);
		}, [paging.refusal]);

		const answer = request._tag === "Read" ? pagedAnswer(paging) : null;
		// The affordance is offered only where there is a page to ask for, so the surface's own rule
		// ("gone once there is nothing older") and this one cannot disagree about the end of history.
		return answer !== null && answer._tag === "Read" && answer.page.next !== null
			? {answer, onOlder: older}
			: answer?._tag === "Refused"
				? {answer, onRetry: retry}
				: {answer};
	};
	return useSessionTranscript;
};

/**
 * What the two chat renderers are built at: the operator's own flags, read straight out of the
 * module the page server generated from the booted config (`./dev-server.ts`, #8439). It is a plain
 * import rather than a fetch or a prop, which is the whole point — the table below is built
 * synchronously, so a flagged window is the first thing painted rather than the second.
 *
 * Nothing here reaches `../config.ts` at runtime: the flags arrive as generated source and the
 * shape arrives as a type (`./assets.d.ts`), so the page's Node-free walk is unaffected.
 */
const chatOptions: ThinChatWindowOptions = {
	subagentList: features.subagentList,
	chatTurnShape: features.chatTurnShape,
};

const claudeWindow = claudeChatWindow(chatOptions);
const piWindow = piChatWindow(chatOptions);

/**
 * Every renderer the page knows, by the reference a program row names it with — each bound to the
 * predicate over the state it reads, which is what the `ReadableRenderer` type asks for. A renderer
 * put here unguarded does not typecheck, so the rule holds at the table and not by review (#8157).
 */
export const pageRenderers = (call: SpellCaller): Readonly<Record<string, ReadableRenderer>> => ({
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
	[PI_CHAT_WINDOW_REF.ref]: readsState(isAiAgentSessionState, piWindow),
	[CLAUDE_CHAT_WINDOW_REF.ref]: readsState(isAiAgentSessionState, claudeWindow),
	[SESSION_LIST_WINDOW_REF.ref]: readsState(
		isSessionListState,
		sessionListWindow({
			useAnswer: sessionListSource(call),
			useTranscript: sessionTranscriptSource(call),
		}),
	),
});

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
