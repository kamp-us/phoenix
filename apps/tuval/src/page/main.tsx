/**
 * The page's entry. It does three things and stops: ask the dev server where the kernel is, open
 * the one socket, and mount the desk over the shell process it finds in the table.
 *
 * The launch URL is fetched rather than baked in because the token is minted per boot and never
 * written to disk (`../shell/host/serve.ts`); `/__tuval/launch` is answered from memory by the same
 * process that minted it (`./dev-server.ts`).
 */

import {Effect, Option, Schema, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import type {ShellMsg} from "../shell/core/index.ts";
import {attach, SHELL_PROGRAM_ID} from "../shell/transport/index.ts";
import {AttachedDesk} from "./AttachedDesk.tsx";
import {demoRenderers} from "./renderers.tsx";
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

const boot = Effect.gen(function* () {
	const url = yield* launchUrl;
	const page = yield* attach(url);
	const shellProcess = yield* shellProcessOf(page.rows);
	if (Option.isNone(shellProcess)) {
		return yield* Effect.die(new Error("tuval: this kernel is running no shell process"));
	}
	const shell = yield* page.attachProcess<unknown, ShellMsg>(shellProcess.value as never);
	const host = document.getElementById("tuval");
	if (host === null) return yield* Effect.die(new Error("tuval: the page has no #tuval element"));
	const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
	createRoot(host).render(
		<StrictMode>
			<AttachedDesk
				page={page}
				shell={shell}
				renderers={demoRenderers}
				reducedMotion={reducedMotion}
			/>
		</StrictMode>,
	);
}).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.scoped);

Effect.runFork(boot);
