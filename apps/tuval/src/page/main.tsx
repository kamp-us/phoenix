/**
 * The page's entry. It asks the dev server where the kernel is, opens the one socket, mounts the
 * desk over the shell process it finds in the table, and then stays: the socket's scope is the
 * page's lifetime.
 *
 * The launch URL is fetched rather than baked in because the token is minted per boot and never
 * written to disk (`../shell/host/serve.ts`); `/__tuval/launch` is answered from memory by the same
 * process that minted it (`./dev-server.ts`).
 *
 * The root is mounted **before** the attach, not after it. Mounting on success alone left every
 * failure — a refused handshake most of all — showing a blank page with the reason only on the
 * terminal, which is how a transport that refused the page's own origin went unnoticed (#7560).
 */

import {Cause, Effect, Option, Schema, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import type {ShellMsg} from "../shell/core/index.ts";
import {attach, SHELL_PROGRAM_ID} from "../shell/transport/browser.ts";
import {AttachedDesk} from "./AttachedDesk.tsx";
import {pageRenderers} from "./renderers.tsx";
import "../shell/ui/tokens.css";
import "./page.css";

const LAUNCH_ENDPOINT = "/__tuval/launch";

/** The page has no kernel to attach to. Nothing recovers from it; the message is the whole answer. */
class NoLaunchUrl extends Schema.TaggedError<NoLaunchUrl>()("tuval/page/NoLaunchUrl", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return `tuval: ${LAUNCH_ENDPOINT} did not answer with a launch URL: ${String(this.cause)}`;
	}
}

/** The kernel answered, but runs no shell — there is no desk to mount. The message is the answer. */
class NoShellProcess extends Schema.TaggedError<NoShellProcess>()("tuval/page/NoShellProcess", {}) {
	override get message(): string {
		return "tuval: this kernel is running no shell process";
	}
}

const launchUrl = Effect.tryPromise({
	try: () =>
		fetch(LAUNCH_ENDPOINT).then((response) => response.json() as Promise<{readonly url: string}>),
	catch: (cause) => new NoLaunchUrl({cause}),
}).pipe(Effect.map((answer) => answer.url));

/** The shell's process id, read off the table — the page assumes none (#7556). */
const shellProcessOf = (
	rows: Stream.Stream<ReadonlyArray<{readonly id: string; readonly programId: string}>>,
) =>
	Stream.runHead(
		Stream.flatMap(rows, (list) => {
			const shell = list.find((row) => row.programId === SHELL_PROGRAM_ID);
			return shell === undefined ? Stream.empty : Stream.succeed(shell.id);
		}),
	);

/** Shown while the socket is opening, and replaced by the desk or by the reason it never opened. */
const Attaching = () => (
	<div className="tuval-surface">
		<p className="tuval-placeholder" role="status">
			Attaching to the Tuval kernel…
		</p>
	</div>
);

/** The reason, on the page. A founder reading a blank tab has nowhere to learn what refused them. */
const AttachFailed = ({reason}: {readonly reason: string}) => (
	<div className="tuval-surface">
		<div className="tuval-placeholder tuval-attach-failed" role="alert">
			<p>Tuval could not attach to the kernel.</p>
			<p className="tuval-attach-reason">{reason}</p>
		</div>
	</div>
);

const desk = Effect.fn("tuval.page.desk")(function* () {
	const url = yield* launchUrl;
	const page = yield* attach(url);
	const shellProcess = yield* shellProcessOf(page.rows);
	if (Option.isNone(shellProcess)) {
		return yield* Effect.fail(new NoShellProcess());
	}
	const shell = yield* page.attachProcess<unknown, ShellMsg>(shellProcess.value as never);
	const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
	return (
		<AttachedDesk
			page={page}
			shell={shell}
			renderers={pageRenderers}
			reducedMotion={reducedMotion}
		/>
	);
});

const boot = Effect.gen(function* () {
	const host = document.getElementById("tuval");
	if (host === null) return yield* Effect.die(new Error("tuval: the page has no #tuval element"));
	const root = createRoot(host);
	root.render(
		<StrictMode>
			<Attaching />
		</StrictMode>,
	);
	const shown = yield* desk().pipe(
		Effect.catchCause((cause) =>
			Effect.succeed(
				<AttachFailed
					reason={Cause.prettyErrors(cause)
						.map((error) => error.message)
						.join("; ")}
				/>,
			),
		),
	);
	root.render(<StrictMode>{shown}</StrictMode>);
	// The scope must outlive the render. `attach` acquires the socket against it and forks the read
	// loop with `Effect.forkScoped` (`../shell/transport/client.ts`), so an `Effect.scoped` that
	// closes when this effect completes interrupts the read loop and runs the socket's finalizer the
	// instant the desk first paints: one snapshot, then a deaf desk and every dispatch written to a
	// closed socket. The page's lifetime is the socket's lifetime, and nothing shorter (#7499).
	return yield* Effect.never;
}).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.scoped);

Effect.runFork(boot);
