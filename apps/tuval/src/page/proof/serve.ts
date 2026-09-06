/**
 * The harness the browser proof drives: `pnpm proof:page-reconnect` from `apps/tuval`.
 *
 * It boots the Pi vertical on the faux provider and chats it twice (`../../pi/proof/vertical.ts`),
 * serves the kernel's transport, puts `./relay.ts` in front of that transport, and serves the real
 * page onto the relay. So the page a browser loads is `../main.tsx` over a real socket, and the one
 * thing the proof can do that a founder cannot is take the wire away and give it back.
 *
 * **The kernel is never touched by a cut.** The relay is the only thing that goes down, so a proof
 * that finds the same process id and a fresh reply on the other side has proven the page recovered,
 * not that something restarted underneath it.
 *
 * The control server is the proof's hands: the spec cannot reach into this process, so every act it
 * needs — cut, restore, send a prompt, read the process id — is one endpoint here. Nothing on it is
 * reachable from the page, and nothing the page does can call it.
 *
 * A prompt goes through a queue this command's own fiber drains rather than straight off the HTTP
 * handler. `Effect.runPromise` from a handler starts a fiber with none of this command's context,
 * and a dispatch made from one never reaches the agent: the request hangs, which reads as a Pi
 * stall rather than as the wiring mistake it is.
 *
 * Run it by hand and it prints both URLs and stays up; a founder can cut and restore with `curl`
 * and watch the desk recover.
 */

import {createServer} from "node:http";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Deferred, Effect, Exit, Queue} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {PROMPT_1} from "../../pi/proof/names.ts";
import {appRoot, bootChattedVertical} from "../../pi/proof/vertical.ts";
import {serveDesk} from "../../shell/host/index.ts";
import {defaultPrefixTable} from "../../shell/keys/index.ts";
import type {TransportServer} from "../../shell/transport/server.ts";
import {servePage} from "../dev-server.ts";
import {CONTROL_PORTS, NO_RECOVERY_PATH} from "./names.ts";
import {serveRelay} from "./relay.ts";

const proof = Command.make(
	"page-reconnect-proof",
	{
		controlPort: Flag.integer("control-port").pipe(
			Flag.withDescription("Port for the proof's control endpoints"),
			Flag.withDefault(CONTROL_PORTS.recovering),
		),
	},
	Effect.fn(function* ({controlPort}) {
		const vertical = yield* bootChattedVertical({prompts: [PROMPT_1]});
		const transport = yield* serveDesk({
			kernel: vertical.kernel,
			port: 0,
			table: defaultPrefixTable,
		});
		const relay = yield* serveRelay({upstreamUrl: transport.launchUrl});
		// The page is told the relay's address and nothing else changes: `admitLoopbackPort` still
		// admits this page server's origin on the real transport, and the token still rides the URL.
		const relayed: TransportServer = {
			port: relay.port,
			publishRegistry: transport.publishRegistry,
			launchUrl: relay.url,
			admitLoopbackPort: transport.admitLoopbackPort,
		};
		const page = yield* servePage({root: appRoot, transport: relayed, port: 0}).pipe(Effect.orDie);

		const state = () => ({
			pageUrl: page.url,
			noRecoveryUrl: new URL(NO_RECOVERY_PATH, page.url).toString(),
			processId: vertical.agent.id,
			replies: vertical.replies(),
			live: relay.live(),
		});

		/** One prompt, and where its answer goes: `null` for done, otherwise the failure to report. */
		interface PromptRequest {
			readonly text: string;
			readonly key: string;
			readonly done: Deferred.Deferred<string | null>;
		}
		const prompts = yield* Queue.make<PromptRequest>();
		yield* Effect.forkScoped(
			Effect.gen(function* () {
				for (;;) {
					const request = yield* Queue.take(prompts);
					const outcome = yield* Effect.exit(vertical.prompt(request.text, request.key));
					yield* Deferred.succeed(
						request.done,
						Exit.isSuccess(outcome) ? null : String(outcome.cause),
					);
				}
			}),
		);

		const control = yield* Effect.acquireRelease(
			Effect.sync(() =>
				createServer((request, response) => {
					const url = new URL(request.url ?? "/", `http://127.0.0.1:${controlPort}`);
					const answer = (body: unknown) => {
						response.setHeader("content-type", "application/json");
						response.end(JSON.stringify(body));
					};
					if (url.pathname === "/state") return answer(state());
					if (url.pathname === "/cut") {
						relay.cut();
						return answer(state());
					}
					if (url.pathname === "/restore") {
						relay.restore();
						return answer(state());
					}
					if (url.pathname === "/prompt") {
						const text = url.searchParams.get("text") ?? "";
						const key = url.searchParams.get("key") ?? "control";
						void Effect.runPromise(
							Effect.gen(function* () {
								const done = yield* Deferred.make<string | null>();
								yield* Queue.offer(prompts, {text, key, done});
								return yield* Deferred.await(done);
							}),
						).then((failure) => {
							if (failure !== null) response.statusCode = 500;
							answer(failure === null ? state() : {error: failure});
						});
						return;
					}
					response.statusCode = 404;
					answer({error: `no such control: ${url.pathname}`});
				}),
			),
			(running) => Effect.sync(() => running.close()),
		);
		yield* Effect.callback<void>((resume) => {
			control.listen(controlPort, "127.0.0.1", () => resume(Effect.void));
		});

		yield* Console.log(`page-reconnect proof: project ${vertical.project}`);
		yield* Console.log(`page-reconnect proof: process ${vertical.agent.id}`);
		yield* Console.log(`page-reconnect proof: desk at ${page.url}`);
		yield* Console.log(`page-reconnect proof: recovery off at ${state().noRecoveryUrl}`);
		yield* Console.log(
			`page-reconnect proof: controls at http://127.0.0.1:${controlPort}/{state,cut,restore,prompt}`,
		);
		return yield* Effect.never;
	}, Effect.scoped),
).pipe(
	Command.withDescription(
		"Serve the real page over a cuttable relay, so a browser can be dropped and restored",
	),
);

proof.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
