/**
 * The admission test a page's renderer table puts in front of every renderer: one predicate over the
 * process state, applied to what the wire actually sent, before the renderer is mounted over it.
 *
 * The wire carries whatever the kernel on the other end holds, and in dev that kernel can predate
 * the browser by a state-shape commit — #8157: a kernel from before `a864e555` kept sending the
 * bare `PermissionRequest` while Vite had hot-reloaded the page onto the renderer that reads
 * `progress.status` off it. A renderer typed against the new shape then throws inside React's
 * render, which is the one fault a window cannot show for itself.
 *
 * A state its renderer's own predicate refuses is refused here instead, exactly as `loadCheckpoint`
 * refuses an unreadable checkpoint rather than opening over it (`../ai-agent/core/snapshot.ts`,
 * #7514): the window renders a refusal that names itself, the desk keeps every other window, and
 * the process keeps running.
 */

import {Effect, Fiber, Stream} from "effect";
import type {ReactElement, ReactNode} from "react";
import {useEffect, useState} from "react";
import type {Message, ProcessId} from "../process/process.ts";
import type {RendererKind} from "../registry/program.ts";
import type {
	AnyWindowHost,
	AnyWindowRenderer,
	ViewState,
	WindowRenderer,
} from "../shell/window/index.ts";

/**
 * The brand only `readsState` can set. It is a module-private `unique symbol`, so no other module
 * can name the key at the type level or reach it at runtime: a hand-written table entry carrying an
 * `admits` of its own does not satisfy `ReadableRenderer` without a cast, which is what makes the
 * table's type the enforcement of the rule rather than a description of it (ADR 0358).
 */
const admitted = Symbol("tuval/page/readsState");

/**
 * A renderer that has declared what it can read. `admits` is the renderer's own predicate, kept on
 * the value rather than closed over, so a table of these can be asked whether every entry really
 * carries one — the rule of `.patterns/window-renderer-admission.md` is checkable, not just typed.
 */
export interface ReadableRenderer {
	readonly [admitted]: true;
	readonly kind: RendererKind;
	readonly render: (host: AnyWindowHost) => ReactNode;
	readonly admits: (state: unknown) => boolean;
	/** The renderer this guards, so a table entry is still identifiable with the renderer it names. */
	readonly renderer: AnyWindowRenderer;
}

/** Before the first state arrives there is nothing to admit and nothing to render. */
export const Pending = (): ReactElement => (
	<p className="tuval-placeholder" role="status">
		Waiting for the first state from this process.
	</p>
);

/**
 * What a founder sees instead of a blank window. It names the process and the likely cause, because
 * the one action that clears this is restarting the kernel that is still sending the old shape.
 */
function Unreadable({processId}: {readonly processId: ProcessId}): ReactElement {
	return (
		<div className="tuval-placeholder" role="alert">
			<p>
				Process {processId} is sending a state this window cannot read, so nothing was rendered over
				it.
			</p>
			<p>
				The usual cause is a kernel older than this page — restart the kernel and the window reads
				the process again. Every other window is unaffected.
			</p>
		</div>
	);
}

type Admission = "unknown" | "readable" | "unreadable";

const admissionOf = (
	admits: (state: unknown) => boolean,
	view: {readonly _tag: string; readonly state?: unknown},
): Admission =>
	// A gone process is the window contract's own arm, not a state to admit: the renderer reads it
	// back through the same stream and shows what it shows for a process that left.
	view._tag === "Live" ? (admits(view.state) ? "readable" : "unreadable") : "readable";

function ReadableWindow({
	admits,
	render,
	host,
}: {
	readonly admits: (state: unknown) => boolean;
	readonly render: (host: AnyWindowHost) => ReactNode;
	readonly host: AnyWindowHost;
}): ReactElement {
	const [admission, setAdmission] = useState<Admission>("unknown");
	const read = host.readProcess;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(read, (view) => Effect.sync(() => setAdmission(admissionOf(admits, view)))),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [read, admits]);
	// The renderer is mounted only from "readable", so it never subscribes to a stream whose current
	// value it cannot read — which is what keeps a skewed state a refusal instead of a throw.
	if (admission === "unknown") return <Pending />;
	if (admission === "unreadable") return <Unreadable processId={host.processId} />;
	return <>{render(host)}</>;
}

/**
 * Bind a renderer to the predicate over the state it reads. The predicate's `S` is the renderer's
 * own, so a table entry that pairs a renderer with another program's predicate is a compile error
 * where the pair is written.
 */
export const readsState = <S, M extends Message, V extends ViewState>(
	admits: (state: unknown) => state is S,
	renderer: WindowRenderer<ReactNode, S, M, V>,
): ReadableRenderer => ({
	[admitted]: true,
	kind: renderer.kind,
	admits,
	renderer,
	render: (host: AnyWindowHost): ReactNode => (
		// The one cast, and it is sound exactly here: `ReadableWindow` calls this `render` only over
		// a state `admits` has returned true for, which is what the renderer's own `S` claims.
		<ReadableWindow
			admits={admits}
			render={renderer.render as (host: AnyWindowHost) => ReactNode}
			host={host}
		/>
	),
});
