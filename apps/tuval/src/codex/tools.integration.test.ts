import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {KernelBridge} from "../ai-agent/tools/KernelBridge.ts";
import {serveKernelTools} from "./tools.ts";
import {disconnected} from "./transport.ts";

const bridge = KernelBridge.scripted({
	child: {
		program: "echo",
		inPorts: {input: {kind: "text", accepts: (value) => typeof value === "string"}},
		outPorts: {output: ["hello"]},
	},
});
const attempt = <A>(body: () => Promise<A>) => Effect.tryPromise({try: body, catch: disconnected});

describe("Codex kernel tools over loopback MCP", () => {
	it("requires the token, refuses browser origins, and stops listening when closed", async () => {
		const url = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const server = yield* serveKernelTools();
					const missing = yield* attempt(() => fetch(server.url));
					expect(missing.status).toBe(403);
					const browser = yield* attempt(() =>
						fetch(server.url, {headers: {...server.http_headers, Origin: "http://evil.example"}}),
					);
					expect(browser.status).toBe(403);
					return server.url;
				}),
			).pipe(Effect.provide(bridge)),
		);
		await expect(fetch(url)).rejects.toThrow();
	});

	it("offers only spawn/send/read and uses the same kernel bridge as Claude", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const server = yield* serveKernelTools();
					const client = new Client({name: "tuval-test", version: "1"});
					yield* Effect.acquireRelease(
						attempt(() =>
							client.connect(
								new StreamableHTTPClientTransport(new URL(server.url), {
									requestInit: {headers: server.http_headers},
								}),
							),
						),
						() => attempt(() => client.close()).pipe(Effect.ignore),
					);
					const tools = yield* attempt(() => client.listTools());
					expect(tools.tools.map((tool) => tool.name)).toEqual(["spawn", "send", "read"]);
					expect(
						yield* attempt(() => client.callTool({name: "spawn", arguments: {program: "echo"}})),
					).toMatchObject({content: [{text: '{"process":"child"}'}]});
					expect(
						yield* attempt(() =>
							client.callTool({
								name: "send",
								arguments: {process: "child", port: "input", payload: "hello"},
							}),
						),
					).toMatchObject({content: [{text: '{"delivered":true,"evicted":0}'}]});
					expect(
						yield* attempt(() =>
							client.callTool({name: "read", arguments: {process: "child", port: "output"}}),
						),
					).toMatchObject({content: [{text: '{"empty":false,"value":"hello"}'}]});
					expect(
						yield* attempt(() =>
							client.callTool({
								name: "send",
								arguments: {process: "child", port: "input", payload: 123},
							}),
						),
					).toMatchObject({isError: true});
					expect(
						yield* attempt(() => client.callTool({name: "spawn", arguments: {program: 123}})),
					).toMatchObject({isError: true});
				}),
			).pipe(Effect.provide(bridge)),
		);
	});
});
