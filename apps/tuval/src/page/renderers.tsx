/**
 * The page's renderer table. The table lives here and not on the program row because a row is
 * kernel-side data that must stay free of React.
 *
 * It is keyed by **program id**, not by the row's `RendererRef.ref`, and that is forced rather than
 * chosen: the process-table wire (`../shell/transport/wire.ts`) carries a row's id, program, parent,
 * ports and state summary, and no renderer field — so the ref a row declares never reaches the page.
 * A row's `renderer` still decides whether the picker offers it at all
 * (`../shell/picker/entries.ts`), which is the whole reason the demo rows carry one.
 *
 * The two demo renderers below are the demo programs' (#7517). Each reads its process through the
 * window contract's `readProcess` and nothing else: no store, no fetch, no socket.
 *
 * The Pi entry is `PiChatWindow` (#7611), and it is why this module is out of the kernel's strict
 * lens and inside `tsconfig.design.json`'s: the chat window is built on `@kampus/design`, which is
 * source-consumed and authored with `exactOptionalPropertyTypes: false`. The program id comes off
 * `../pi/renderer-ref.ts` rather than off the row in `../pi/program.ts`, because that row imports
 * `node:path` and Pi's model runtime and would pull the whole kernel into the page bundle (#7836).
 */

import {Effect, Fiber, Stream} from "effect";
import type {ReactElement, ReactNode} from "react";
import {useEffect, useState} from "react";
import {type CounterState, counterId} from "../demo/counter.ts";
import {type LogState, logId} from "../demo/log.ts";
import {PI_SESSION_PROGRAM} from "../pi/renderer-ref.ts";
import {PiChatWindow} from "../pi/window/index.ts";
import type {ReactWindowRenderer} from "../shell/ui/index.ts";
import type {AnyWindowHost, ProcessView} from "../shell/window/index.ts";

/**
 * One process's public state, live. The stream never fails and ends on `ProcessGone`, so the hook
 * needs no error arm: `null` means "nothing yet", and a gone process simply stops updating.
 */
const useProcessState = <S,>(host: AnyWindowHost): S | null => {
	const [state, setState] = useState<S | null>(null);
	const read = host.readProcess as Stream.Stream<ProcessView<S>>;
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

const Pending = (): ReactElement => (
	<p className="tuval-placeholder" role="status">
		Waiting for the first state from this process.
	</p>
);

function CounterRenderer({host}: {readonly host: AnyWindowHost}): ReactElement {
	const state = useProcessState<CounterState>(host);
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

function LogRenderer({host}: {readonly host: AnyWindowHost}): ReactElement {
	const state = useProcessState<LogState>(host);
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

/** Every renderer the page knows, by program id. */
export const pageRenderers: ReadonlyMap<string, ReactWindowRenderer> = new Map<
	string,
	ReactWindowRenderer
>([
	[counterId, (host): ReactNode => <CounterRenderer host={host} />],
	[logId, (host): ReactNode => <LogRenderer host={host} />],
	[PI_SESSION_PROGRAM, (host): ReactNode => PiChatWindow.render(host)],
]);
