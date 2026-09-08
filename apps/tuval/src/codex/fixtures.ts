import {type Cause, Effect, Layer, Queue, Schema, Stream} from "effect";
import {
	type TransportError,
	TuvalAiAgent,
	type TuvalAiAgentApi,
} from "../ai-agent/service/index.ts";
import {KernelBridge} from "../ai-agent/tools/KernelBridge.ts";
import {CodexAiAgent, type CodexAiAgentOptions} from "./CodexAiAgent.ts";
import type {CodexConnect, CodexConnection, RequestId, ServerMessage} from "./transport.ts";

export const thread = {
	id: "session-1",
	cwd: "/tmp/tuval-codex-test",
	preview: "hello",
	createdAt: 1,
	updatedAt: 2,
	historyMode: "legacy",
	turns: [],
	gitInfo: {branch: "main"},
	canAcceptDirectInput: true,
};
export const opened = {
	thread,
	model: "model-a",
	modelProvider: "openai",
	approvalPolicy: "on-request",
	sandbox: {type: "workspaceWrite"},
	reasoningEffort: "medium",
};
export const modelRows = [
	{
		model: "model-a",
		displayName: "Model A",
		hidden: false,
		supportedReasoningEfforts: [
			{reasoningEffort: "low"},
			{reasoningEffort: "medium"},
			{reasoningEffort: "high"},
		],
		defaultReasoningEffort: "medium",
	},
	{
		model: "model-b",
		displayName: "Model B",
		hidden: false,
		supportedReasoningEfforts: [{reasoningEffort: "low"}],
		defaultReasoningEffort: "low",
	},
];
export const turn = (status = "inProgress") => ({id: "turn-1", status, items: [], error: null});
export const itemMessage = (type: "started" | "completed", item: unknown): ServerMessage => ({
	method: `item/${type}`,
	params: {threadId: thread.id, turnId: "turn-1", item},
});
export const turnMessage = (type: "started" | "completed", status?: string): ServerMessage => ({
	method: `turn/${type}`,
	params: {
		threadId: thread.id,
		turn: turn(status ?? (type === "started" ? "inProgress" : "completed")),
	},
});

export const fakeCodex = Effect.gen(function* () {
	const queue = yield* Queue.unbounded<ServerMessage, TransportError | Cause.Done>();
	const calls: Array<{method: string; params: unknown}> = [];
	const replies: Array<{id: RequestId; result: unknown}> = [];
	const rejected: Array<RequestId> = [];
	const state = {closed: 0, opened: 0};
	const handlers = new Map<string, (params: unknown) => Effect.Effect<unknown, TransportError>>();
	const connection: CodexConnection = {
		request: (method, params) =>
			Effect.suspend(() => {
				calls.push({method, params});
				const handler = handlers.get(method);
				if (handler !== undefined) return handler(params);
				switch (method) {
					case "thread/start":
					case "thread/resume":
						return Effect.succeed(opened);
					case "model/list":
						return Effect.succeed({data: modelRows, nextCursor: null});
					case "thread/list":
						return Effect.succeed({
							data: Schema.decodeUnknownSync(Schema.Struct({archived: Schema.Boolean}))(params)
								.archived
								? []
								: [thread],
							nextCursor: null,
						});
					case "thread/read":
						return Effect.succeed({thread});
					case "thread/settings/update":
						return Effect.succeed({});
					case "turn/start":
						return Effect.succeed({turn: turn()});
					case "turn/interrupt":
						return Queue.offer(queue, turnMessage("completed", "interrupted")).pipe(Effect.as({}));
					default:
						return Effect.die(`Unexpected method ${method}`);
				}
			}),
		reply: (id, result) =>
			Effect.sync(() => {
				replies.push({id, result});
			}),
		reject: (id) =>
			Effect.sync(() => {
				rejected.push(id);
			}),
		messages: Stream.fromQueue(queue),
	};
	const connect: CodexConnect = () =>
		Effect.gen(function* () {
			state.opened++;
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					state.closed++;
				}),
			);
			return connection;
		});
	return {
		connect,
		connection,
		calls,
		replies,
		rejected,
		state,
		handlers,
		queue,
		push: (message: ServerMessage) => Queue.offer(queue, message),
	};
});
export type FakeCodex = Effect.Success<typeof fakeCodex>;

export const onCodex = <A, E, R>(
	body: (agent: TuvalAiAgentApi, fake: FakeCodex) => Effect.Effect<A, E, R>,
	options: CodexAiAgentOptions = {},
) =>
	Effect.gen(function* () {
		const fake = yield* fakeCodex;
		return yield* Effect.gen(function* () {
			return yield* body(yield* TuvalAiAgent, fake);
		}).pipe(
			Effect.provide(
				CodexAiAgent.layer({
					...options,
					connect: fake.connect,
					openTools: () =>
						Effect.succeed({
							url: "http://127.0.0.1:1/mcp",
							http_headers: {Authorization: "Bearer test-only"},
						}),
				}).pipe(Layer.provide(KernelBridge.scripted({}))),
			),
		);
	}).pipe(Effect.scoped);
