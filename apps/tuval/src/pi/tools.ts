/**
 * The three kernel tools the Pi program offers the model, as plain `customTools`.
 *
 * The third adapter over one `KernelBridge` (#8720, ruling R9.1 on #8715): Claude's turns it into
 * an in-process MCP server and Codex's into an HTTP one, and Pi needs neither — at the
 * `@earendil-works/pi-coding-agent@0.85.1` pin `createAgentSession` takes
 * `customTools?: ToolDefinition[]` (`dist/core/sdk.d.ts:47`), so the names are bare: `spawn`,
 * `send`, `read`.
 *
 * A `ToolDefinition.execute` is a plain `async` function, so Effect runs *inside* it, through the
 * `runPromise` the calling process built once over its own services — the same seam Claude's
 * handlers use, so a tool call runs under that process's spans and loggers.
 *
 * **A refusal is thrown, and that is Pi's only tool-error channel.** `AgentToolResult` at this pin
 * carries `content`, `details`, `usage`, `addedToolNames` and `terminate` and no error flag
 * (`@earendil-works/pi-agent-core` `dist/types.d.ts:317-331`); the agent loop turns a rejected
 * `execute` into `createErrorToolResult(error.message)` with `isError: true`
 * (`dist/agent-loop.js:460-486`). So the Effect these handlers run can never fail — every
 * `BridgeError` is caught and rendered first — and the one throw that leaves a handler is the
 * deliberate `KernelToolRefused` naming the refusal.
 */

import type {AgentToolResult, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {Effect, Option} from "effect";
import {Type} from "typebox";
import type {BridgeError} from "../ai-agent/tools/errors.ts";
import type {KernelBridge} from "../ai-agent/tools/KernelBridge.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";

/** How a handler runs its Effect: the calling process's own runtime, built once over its services. */
export type ToolRun = <A>(effect: Effect.Effect<A>) => Promise<A>;

/** A bridge refusal, as the rejection Pi turns into the model's tool error. */
export class KernelToolRefused extends Error {
	constructor(refusal: BridgeError) {
		super(`${refusal._tag}: ${refusal.message}`);
		this.name = "KernelToolRefused";
	}
}

/** A tool answer carries no details, so the type parameter is fixed and the field is always absent. */
type KernelToolResult = AgentToolResult<undefined>;

const KERNEL =
	"Tuval's kernel is a registry of programs and a table of running processes; a process has typed ports, an in-port you write to and an out-port you read from.";

const SPAWN_DESCRIPTION = `Start a new process of a program the registry knows, as a child of your own process. ${KERNEL} Answers with the new process's id.`;
const SEND_DESCRIPTION = `Write one payload to a named in-port of a process you spawned. ${KERNEL} The port decides what it takes, and a payload it refuses is an error naming what the port takes. The reply also carries \`evicted\`: how many queued payloads the port discarded unread to make room for this one, which is non-zero only on a port that keeps the latest rather than blocking.`;
const READ_DESCRIPTION = `Read the current value of a named out-port of a process you spawned. ${KERNEL} A port that has said nothing yet answers empty rather than making you wait.`;

const spawnParameters = Type.Object({
	program: Type.String({description: "The id of a registered program."}),
});
const sendParameters = Type.Object({
	process: Type.String({description: "The id of a process you spawned."}),
	port: Type.String({description: "The name of one of that process's in-ports."}),
	payload: Type.Unknown({
		description: "The value to write; the port's own kind decides its shape.",
	}),
});
const readParameters = Type.Object({
	process: Type.String({description: "The id of a process you spawned."}),
	port: Type.String({description: "The name of one of that process's out-ports."}),
});

const text = (value: unknown): KernelToolResult => ({
	content: [{type: "text", text: JSON.stringify(value)}],
	details: undefined,
});

/**
 * What one bridge call settles to: the answer the model gets, or the refusal to throw.
 *
 * Two steps rather than one because the Effect and the throw belong on opposite sides of the
 * `runPromise` boundary — failing the Effect would reject with Effect's own `FiberFailure`, whose
 * message is a rendered cause rather than the refusal's sentence.
 */
type Settled =
	| {readonly ok: true; readonly result: KernelToolResult}
	| {readonly ok: false; readonly refusal: BridgeError};

const answer = async <A>(
	run: ToolRun,
	effect: Effect.Effect<A, BridgeError>,
	render: (value: A) => KernelToolResult,
): Promise<KernelToolResult> => {
	const settled = await run(
		effect.pipe(
			Effect.map((value): Settled => ({ok: true, result: render(value)})),
			Effect.catch((refusal: BridgeError) => Effect.succeed<Settled>({ok: false, refusal})),
		),
	);
	if (!settled.ok) throw new KernelToolRefused(settled.refusal);
	return settled.result;
};

/** The handlers as this module types them, so a test drives one without Pi's `execute` shape. */
export interface PiKernelToolHandlers {
	readonly spawn: (args: {readonly program: string}) => Promise<KernelToolResult>;
	readonly send: (args: {
		readonly process: string;
		readonly port: string;
		readonly payload: unknown;
	}) => Promise<KernelToolResult>;
	readonly read: (args: {
		readonly process: string;
		readonly port: string;
	}) => Promise<KernelToolResult>;
}

export const piKernelToolHandlers = (
	bridge: KernelBridge["Service"],
	run: ToolRun,
): PiKernelToolHandlers => ({
	spawn: (args) =>
		answer(run, bridge.spawn(ProgramId.make(args.program)), (process) => text({process})),
	send: (args) =>
		answer(run, bridge.send(ProcessId.make(args.process), args.port, args.payload), text),
	read: (args) =>
		answer(run, bridge.read(ProcessId.make(args.process), args.port), (held) =>
			Option.isSome(held) ? text({empty: false, value: held.value}) : text({empty: true}),
		),
});

/**
 * The three definitions `createAgentSession` takes on `customTools`, in registration order.
 *
 * `ToolDefinition` is generic in its parameter schema, so each entry carries its own
 * `satisfies ToolDefinition<typeof …>`: the entry is checked against the schema it actually declares
 * while the array itself stays the `ReadonlyArray<ToolDefinition>` the caller wants.
 */
export const piKernelTools = (
	bridge: KernelBridge["Service"],
	run: ToolRun,
): ReadonlyArray<ToolDefinition> => {
	const handlers = piKernelToolHandlers(bridge, run);
	return [
		{
			name: "spawn",
			label: "Spawn",
			description: SPAWN_DESCRIPTION,
			parameters: spawnParameters,
			execute: (_id, params) => handlers.spawn(params),
		} satisfies ToolDefinition<typeof spawnParameters, undefined>,
		{
			name: "send",
			label: "Send",
			description: SEND_DESCRIPTION,
			parameters: sendParameters,
			execute: (_id, params) => handlers.send(params),
		} satisfies ToolDefinition<typeof sendParameters, undefined>,
		{
			name: "read",
			label: "Read",
			description: READ_DESCRIPTION,
			parameters: readParameters,
			execute: (_id, params) => handlers.read(params),
		} satisfies ToolDefinition<typeof readParameters, undefined>,
	];
};
