import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect, Layer, Stream} from "effect";
import {describe, expect, it} from "vitest";
import {isThinkingLevel} from "../ai-agent/ports/index.ts";
import {TuvalAiAgent} from "../ai-agent/service/index.ts";
import {KernelBridge} from "../ai-agent/tools/KernelBridge.ts";
import {CodexAiAgent} from "./CodexAiAgent.ts";
import {decode, Models, Opened} from "./protocol.ts";
import {serveKernelTools} from "./tools.ts";
import {nodeConnection} from "./transport.ts";

// No model turns or real credentials. Opt in only on a machine with codex-cli 0.153.4 installed.
describe.skipIf(process.env.TUVAL_CODEX_PROTOCOL_TEST !== "1")("installed Codex protocol", () => {
	it("opens a thread, changes settings and calls Tuval tools without generation", async () => {
		const home = await mkdtemp(join(tmpdir(), "tuval-codex-protocol-"));
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const tools = yield* serveKernelTools();
						const connection = yield* nodeConnection({env: {CODEX_HOME: home}})(home);
						const value = yield* connection.request("thread/start", {
							cwd: home,
							ephemeral: true,
							sandbox: "read-only",
							approvalPolicy: "on-request",
							approvalsReviewer: "user",
							config: {"mcp_servers.tuval": {...tools, enabled: true, required: true}},
						});
						const opened = yield* decode(Opened, value);
						expect(opened.sandbox.type).toBe("readOnly");
						expect(opened.approvalPolicy).toBe("on-request");
						const catalog = yield* connection
							.request("model/list", {limit: 100})
							.pipe(Effect.flatMap((reply) => decode(Models, reply)));
						expect(catalog.data.length).toBeGreaterThan(0);
						const unrepresented = [
							...new Set(
								catalog.data
									.flatMap((row) =>
										row.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
									)
									.filter((effort) => !isThinkingLevel(effort)),
							),
						];
						expect(unrepresented).toEqual([]);
						expect(
							yield* connection.request("thread/settings/update", {
								threadId: opened.thread.id,
								sandboxPolicy: {type: "readOnly"},
							}),
						).toEqual({});
						const result = yield* connection.request("mcpServer/tool/call", {
							threadId: opened.thread.id,
							server: "tuval",
							tool: "spawn",
							arguments: {program: "echo"},
						});
						expect(result).toMatchObject({content: [{type: "text", text: '{"process":"child"}'}]});
					}),
				).pipe(
					Effect.provide(
						KernelBridge.scripted({child: {program: "echo", inPorts: {}, outPorts: {}}}),
					),
				),
			);
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const agent = yield* TuvalAiAgent;
						expect(yield* agent.listSessions).toEqual([]);
						expect((yield* agent.start({cwd: home})).sessionId).not.toBe("");
						expect(yield* agent.events.pipe(Stream.take(6), Stream.runCollect)).toMatchObject([
							{kind: "phase", phase: "starting"},
							{kind: "mode", current: "read-only"},
							{kind: "model"},
							{kind: "thinking"},
							{kind: "commands"},
							{kind: "phase", phase: "ready"},
						]);
						expect(yield* agent.page(null, 20)).toMatchObject({hasMore: false});
						yield* agent.setThinkingLevel("low");
					}),
				).pipe(
					Effect.provide(
						CodexAiAgent.layer({env: {CODEX_HOME: home}, mode: "read-only"}).pipe(
							Layer.provide(KernelBridge.scripted({})),
						),
					),
				),
			);
		} finally {
			await rm(home, {recursive: true, force: true});
		}
	});
});
