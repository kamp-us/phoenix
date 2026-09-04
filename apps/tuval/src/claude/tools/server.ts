/**
 * The three tools the Claude program offers the model, as one in-process MCP server.
 *
 * Registering them on a server named `tuval` is what makes the model call them
 * `mcp__tuval__spawn`, `mcp__tuval__send` and `mcp__tuval__read`, and listing exactly those wire
 * names in `Options.allowedTools` is enough to skip the permission prompt (spike #7597 finding 1).
 * `wireName` is derived from the server name rather than written twice, so the row that mounts this
 * server and the server itself cannot disagree about what the model will see.
 *
 * The SDK gives no hook for handing it an Effect runtime, so a handler is a plain `async` function
 * and Effect runs *inside* it, through the `ToolRuntime` the calling process built once (spike
 * finding 2). A bridge refusal becomes an `isError` result carrying the tag; nothing here throws.
 *
 * The descriptions say what the kernel is and name no program: which programs exist is something
 * the model asks the kernel, not something this file knows.
 */

import type {McpSdkServerConfigWithInstance} from "@anthropic-ai/claude-agent-sdk";
import {createSdkMcpServer, tool} from "@anthropic-ai/claude-agent-sdk";
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {Effect, Option} from "effect";
import {z} from "zod";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import type {BridgeError} from "./errors.ts";
import type {KernelBridge} from "./KernelBridge.ts";

/** The MCP server name. It is half of every wire name, so it is written once. */
export const TUVAL_SERVER_NAME = "tuval";

export const wireNameOf = (name: string): string => `mcp__${TUVAL_SERVER_NAME}__${name}`;

/**
 * The runtime a handler runs its Effect through: one per process, built where that process's
 * services are (spike #7597 finding 2). An Effect reaching it needs nothing and cannot fail — the
 * handler has already turned every bridge refusal into a result.
 */
export interface ToolRuntime {
	readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
}

/** One registered tool, as a reader of `Options.allowedTools` needs it. */
export interface RegisteredTool {
	readonly name: string;
	readonly description: string;
	readonly wireName: string;
}

export interface TuvalToolServer {
	readonly name: string;
	readonly tools: ReadonlyArray<RegisteredTool>;
	/** The three names `Options.allowedTools` must list, in registration order. */
	readonly wireNames: ReadonlyArray<string>;
	/** The handlers as this module typed them, so a caller drives one without the SDK's shape. */
	readonly handlers: {
		readonly spawn: (args: {readonly program: string}) => Promise<CallToolResult>;
		readonly send: (args: {
			readonly process: string;
			readonly port: string;
			readonly payload: unknown;
		}) => Promise<CallToolResult>;
		readonly read: (args: {
			readonly process: string;
			readonly port: string;
		}) => Promise<CallToolResult>;
	};
	/** What goes on `Options.mcpServers` under `TUVAL_SERVER_NAME`. */
	readonly server: McpSdkServerConfigWithInstance;
}

const KERNEL =
	"Tuval's kernel is a registry of programs and a table of running processes; a process has typed ports, an in-port you write to and an out-port you read from.";

const SPAWN_DESCRIPTION = `Start a new process of a program the registry knows, as a child of your own process. ${KERNEL} Answers with the new process's id.`;
const SEND_DESCRIPTION = `Write one payload to a named in-port of a process you spawned. ${KERNEL} The port decides what it takes, and a payload it refuses is an error naming what the port takes.`;
const READ_DESCRIPTION = `Read the current value of a named out-port of a process you spawned. ${KERNEL} A port that has said nothing yet answers empty rather than making you wait.`;

const text = (value: unknown): CallToolResult => ({
	content: [{type: "text", text: JSON.stringify(value)}],
});

const refused = (error: BridgeError): CallToolResult => ({
	content: [{type: "text", text: `${error._tag}: ${error.message}`}],
	isError: true,
});

/** Every handler's shape: run the bridge call, render its answer, render its refusal. */
const answer = <A>(
	run: ToolRuntime,
	effect: Effect.Effect<A, BridgeError>,
	render: (value: A) => CallToolResult,
): Promise<CallToolResult> =>
	run.runPromise(
		effect.pipe(
			Effect.map(render),
			Effect.catch((error: BridgeError) => Effect.succeed(refused(error))),
		),
	);

export const tuvalToolServer = (
	bridge: KernelBridge["Service"],
	run: ToolRuntime,
): TuvalToolServer => {
	const handlers = {
		spawn: (args: {readonly program: string}) =>
			answer(run, bridge.spawn(ProgramId.make(args.program)), (process) => text({process})),
		send: (args: {readonly process: string; readonly port: string; readonly payload: unknown}) =>
			answer(run, bridge.send(ProcessId.make(args.process), args.port, args.payload), (delivered) =>
				text({delivered}),
			),
		read: (args: {readonly process: string; readonly port: string}) =>
			answer(run, bridge.read(ProcessId.make(args.process), args.port), (held) =>
				Option.isSome(held) ? text({empty: false, value: held.value}) : text({empty: true}),
			),
	};

	const definitions = [
		tool(
			"spawn",
			SPAWN_DESCRIPTION,
			{program: z.string().describe("The id of a registered program.")},
			handlers.spawn,
		),
		tool(
			"send",
			SEND_DESCRIPTION,
			{
				process: z.string().describe("The id of a process you spawned."),
				port: z.string().describe("The name of one of that process's in-ports."),
				payload: z.unknown().describe("The value to write; the port's own kind decides its shape."),
			},
			handlers.send,
		),
		tool(
			"read",
			READ_DESCRIPTION,
			{
				process: z.string().describe("The id of a process you spawned."),
				port: z.string().describe("The name of one of that process's out-ports."),
			},
			handlers.read,
		),
	];

	const tools = definitions.map(
		({name, description}): RegisteredTool => ({name, description, wireName: wireNameOf(name)}),
	);

	return {
		name: TUVAL_SERVER_NAME,
		tools,
		wireNames: tools.map((one) => one.wireName),
		handlers,
		server: createSdkMcpServer({name: TUVAL_SERVER_NAME, tools: definitions}),
	};
};
