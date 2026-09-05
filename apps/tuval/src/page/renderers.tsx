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
 * The Pi entry is `PiChatWindow` (#7611), and it is why this module is out of the kernel's strict
 * lens and inside `tsconfig.design.json`'s: the chat window is built on `@kampus/design`, which is
 * source-consumed and authored with `exactOptionalPropertyTypes: false`. Its key is the reference
 * the Pi row itself declares, imported rather than retyped, so the row and this table cannot name
 * two different renderers.
 */

import {Effect, Fiber, Stream} from "effect";
import type {ReactElement, ReactNode} from "react";
import {useEffect, useState} from "react";
import type {CounterState} from "../demo/counter.ts";
import type {LogState} from "../demo/log.ts";
import {PI_CHAT_WINDOW_REF, PiChatWindow} from "../pi/window/index.ts";
import type {AnyWindowHost, AnyWindowRenderer, ProcessView} from "../shell/window/index.ts";
import {windowRenderer} from "../shell/window/index.ts";

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

/** Every renderer the page knows, by the reference a program row names it with. */
export const pageRenderers: Readonly<Record<string, AnyWindowRenderer>> = {
	"tuval/demo/counter": windowRenderer(
		"host-native",
		(host: AnyWindowHost): ReactNode => <CounterRenderer host={host} />,
	),
	"tuval/demo/log": windowRenderer(
		"host-native",
		(host: AnyWindowHost): ReactNode => <LogRenderer host={host} />,
	),
	[PI_CHAT_WINDOW_REF.ref]: PiChatWindow,
};
