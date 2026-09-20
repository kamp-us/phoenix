/**
 * The extension load against a real `AgentSession`: with `piSubagents` on, the host builds Pi's
 * resource loader itself and hands it to `createAgentSession`, and the session it gets back still
 * opens, prompts and answers.
 *
 * The tools that load are the unit tier's assertion (`./subagents.unit.test.ts`) — it needs no
 * model. What only a real session can say is that a session carrying the extension still runs a
 * turn: `pi-subagents` registers handlers on the session's own lifecycle events, and a handler that
 * threw would break the loop rather than the registration.
 *
 * Pi's own faux provider, so the run costs nothing and calls no model API. The child a `subagent`
 * call would spawn is a detached process with its own `ModelRuntime` and does not reach it (#8555),
 * which is why spawning one is hand-verified on the desk rather than asserted here.
 */

import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage, fauxProvider} from "@earendil-works/pi-ai";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {layer as agentSessionHostLayer} from "./AgentSessionHost.ts";
import {SessionOpenFailed} from "./errors.ts";
import {PiSessionHost} from "./PiSessionHost.ts";
import {subagentExtensionPaths} from "./subagents.ts";

const MODEL = {provider: "faux", id: "faux-1"} as const;

const hostLayer = (cwd: string, piSubagents: boolean) =>
	Layer.unwrap(
		Effect.tryPromise({
			try: async () => {
				const faux = fauxProvider({
					provider: MODEL.provider,
					api: "faux",
					models: [{id: MODEL.id, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
				});
				faux.setResponses([fauxAssistantMessage("hello from faux")]);
				const modelRuntime = await ModelRuntime.create({
					modelsPath: null,
					refreshOnCreate: false,
					allowModelNetwork: false,
					authPath: join(cwd, "agent", "auth.json"),
				});
				modelRuntime.registerNativeProvider(faux.provider);
				const extensionPaths = subagentExtensionPaths({piSubagents});
				return agentSessionHostLayer({
					modelRuntime,
					agentDir: join(cwd, "agent"),
					noTools: "all",
					...(extensionPaths.length === 0 ? {} : {extensionPaths}),
				});
			},
			catch: (cause) => new SessionOpenFailed({cwd, detail: String(cause)}),
		}).pipe(Effect.orDie),
	);

/**
 * One turn, read off the session's own change signal. The signal coalesces, so the reply can land
 * on the first wake or a later one — the loop reads until the answer is in the transcript rather
 * than assuming which wake carries it.
 */
const turn = (cwd: string) =>
	Effect.gen(function* () {
		const host = yield* PiSessionHost;
		const session = yield* host.open({cwd, model: MODEL});
		yield* session.prompt("say hello");
		for (let wake = 0; wake < 20; wake += 1) {
			const view = yield* session.read;
			if (view.transcript.some((item) => item.role === "assistant")) {
				assert.strictEqual(view.model.id, MODEL.id);
				assert.deepStrictEqual(
					view.transcript.map((item) => item.role),
					["user", "assistant"],
				);
				return;
			}
			yield* session.changes;
		}
		return yield* Effect.die(new Error("the faux reply never reached the transcript"));
	}).pipe(Effect.scoped);

describe("a Pi session with the subagent extension loaded", () => {
	it.live("opens, prompts and answers with the flag on", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tuval-pi-subagents-on-"));
		return turn(cwd).pipe(Effect.provide(hostLayer(cwd, true)));
	});

	it.live("opens the same session with the flag off", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tuval-pi-subagents-off-"));
		return turn(cwd).pipe(Effect.provide(hostLayer(cwd, false)));
	});
});
