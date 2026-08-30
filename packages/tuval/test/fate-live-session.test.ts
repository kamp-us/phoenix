import {assert, describe, it} from "@effect/vitest";
import {
	type CurrentUser,
	FateInterpreter,
	type LivePublisher,
	type LiveTopicPublisher,
} from "@kampus/fate-effect";
import {Effect, Layer, Schema, Stream} from "effect";
import {ExtensionUI, makeExtensionUI} from "../src/backend/extension-ui.js";
import {TuvalFateServerLive} from "../src/backend/fate.js";
import {LineageIndex} from "../src/backend/lineage.js";
import {
	LiveSession,
	type LiveSessionService,
	makeUnavailableLiveSession,
} from "../src/backend/live-session.js";
import {PiDiscovery} from "../src/backend/pi-discovery.js";
import {sessionIdentity} from "../src/shared/discovery.js";
import {
	LineageProjection,
	type LineageProjection as LineageProjectionType,
} from "../src/shared/lineage.js";
import type {AttachedLiveSession} from "../src/shared/live-session.js";
import {tryPromise} from "./test-effect.js";

const session: AttachedLiveSession = {
	_tag: "attached",
	sessionId: "session-one",
	revision: 1,
	phase: "idle",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	completion: "idle",
	transcript: [],
	archive: {_tag: "complete", hasMore: false},
	lastEventSequence: 1,
	connection: "connected",
	ownership: "exclusive",
	controls: {
		create: true,
		open: true,
		steer: false,
		abort: false,
		setModel: false,
		setThinking: false,
		models: [],
		thinkingLevels: [],
	},
};

const request = (operations: ReadonlyArray<Record<string, unknown>>) =>
	new Request("http://127.0.0.1/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations}),
	});

const noTopic: LiveTopicPublisher = {
	appendNode: () => Effect.void,
	prependNode: () => Effect.void,
	deleteEdge: () => Effect.void,
	invalidate: () => Effect.void,
};

const context = {
	currentUser: {user: undefined} satisfies typeof CurrentUser.Service,
	livePublisher: {
		update: () => Effect.void,
		delete: () => Effect.void,
		invalidate: () => Effect.void,
		topic: () => noTopic,
	} satisfies typeof LivePublisher.Service,
};

const emptyLineage: LineageProjectionType = {
	graph: {version: 2, nodes: [], edges: [], continuity: [], ownership: []},
	problems: [],
};

const handle = (
	live: LiveSessionService,
	operations: ReadonlyArray<Record<string, unknown>>,
	lineage: LineageProjectionType = emptyLineage,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const app = yield* Layer.build(
				TuvalFateServerLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.succeed(LiveSession, live),
							Layer.succeed(ExtensionUI, makeExtensionUI()),
							Layer.succeed(LineageIndex, {project: () => Effect.succeed(lineage)}),
							Layer.succeed(PiDiscovery, {
								discover: () => Effect.succeed({_tag: "empty", sessions: [] as const}),
								sessionMetadata: () => Effect.succeed({_tag: "not-configured"}),
							}),
						),
					),
				),
			);
			return yield* FateInterpreter.handleRequest(request(operations), context).pipe(
				Effect.provideContext(app),
			);
		}),
	);

const resultOf = (response: Response) => tryPromise(() => response.json());

describe("live-session fate-effect contract", () => {
	it.effect("exposes attach, current state, correlated prompt, and release", () =>
		Effect.gen(function* () {
			const calls: Array<string> = [];
			let current: AttachedLiveSession | null = null;
			const live: LiveSessionService = {
				...makeUnavailableLiveSession(),
				current: () => Effect.succeed(current),
				attach: (sessionId) =>
					Effect.sync(() => {
						calls.push(`attach:${sessionId}`);
						current = session;
						return {_tag: "attached" as const, session};
					}),
				prompt: ({correlationId, text}) =>
					Effect.sync(() => {
						calls.push(`prompt:${correlationId}:${text}`);
						return {_tag: "acknowledged" as const, correlationId, session};
					}),
				release: () =>
					Effect.sync(() => {
						calls.push("release");
						current = null;
						return {_tag: "released" as const, sessionId: session.sessionId};
					}),
				eventsAfter: () => Effect.succeed([]),
				events: () => Stream.empty,
				dispose: () => Effect.void,
			};

			const attached = yield* handle(live, [
				{
					id: "attach",
					kind: "mutation",
					name: "liveSession.attach",
					input: {sessionId: session.sessionId},
					select: [],
				},
			]);
			assert.deepInclude(yield* resultOf(attached), {
				results: [{id: "attach", ok: true, data: {_tag: "attached", session}}],
			});

			const response = yield* handle(live, [
				{id: "current", kind: "query", name: "liveSession.current", select: []},
				{
					id: "prompt",
					kind: "mutation",
					name: "liveSession.prompt",
					input: {correlationId: "prompt-1", text: "hello"},
					select: [],
				},
				{id: "lineage", kind: "query", name: "lineage", select: []},
			]);
			const responseBody = (yield* resultOf(response)) as {
				results: Array<{id: string; ok: boolean; data: Record<string, unknown>}>;
			};
			assert.strictEqual(responseBody.results[0]?.id, "current");
			assert.deepEqual(responseBody.results[0]?.data, session);
			assert.strictEqual(responseBody.results[1]?.id, "prompt");
			assert.strictEqual(responseBody.results[1]?.data._tag, "acknowledged");
			assert.strictEqual(responseBody.results[1]?.data.correlationId, "prompt-1");
			assert.deepEqual(responseBody.results[2]?.data, emptyLineage);

			yield* handle(live, [
				{
					id: "release",
					kind: "mutation",
					name: "liveSession.release",
					input: {},
					select: [],
				},
			]);
			assert.deepEqual(calls, ["attach:session-one", "prompt:prompt-1:hello", "release"]);
		}),
	);

	it.effect("routes all six acknowledged control mutations without a frontend surface", () =>
		Effect.gen(function* () {
			const calls: Array<string> = [];
			const live: LiveSessionService = {
				...makeUnavailableLiveSession(),
				create: ({correlationId}) =>
					Effect.sync(() => {
						calls.push("create");
						return {
							_tag: "acknowledged" as const,
							command: "create" as const,
							correlationId,
							session,
						};
					}),
				open: ({correlationId}) =>
					Effect.sync(() => {
						calls.push("open");
						return {
							_tag: "acknowledged" as const,
							command: "open" as const,
							correlationId,
							session,
						};
					}),
				steer: ({correlationId}) =>
					Effect.sync(() => {
						calls.push("steer");
						return {
							_tag: "acknowledged" as const,
							command: "steer" as const,
							correlationId,
							session,
						};
					}),
				abort: ({correlationId}) =>
					Effect.sync(() => {
						calls.push("abort");
						return {
							_tag: "acknowledged" as const,
							command: "abort" as const,
							correlationId,
							session,
						};
					}),
				setModel: ({correlationId}) =>
					Effect.sync(() => {
						calls.push("set-model");
						return {
							_tag: "acknowledged" as const,
							command: "set-model" as const,
							correlationId,
							session,
							value: session.model,
						};
					}),
				setThinking: ({correlationId}) =>
					Effect.sync(() => {
						calls.push("set-thinking");
						return {
							_tag: "acknowledged" as const,
							command: "set-thinking" as const,
							correlationId,
							session,
							value: session.thinkingLevel,
						};
					}),
			};
			const response = yield* handle(live, [
				{
					id: "create",
					kind: "mutation",
					name: "liveSession.create",
					input: {correlationId: "create-1", cwd: "/tmp/tuval"},
					select: [],
				},
				{
					id: "open",
					kind: "mutation",
					name: "liveSession.open",
					input: {correlationId: "open-1", sessionId: session.sessionId},
					select: [],
				},
				{
					id: "steer",
					kind: "mutation",
					name: "liveSession.steer",
					input: {correlationId: "steer-1", text: "redirect"},
					select: [],
				},
				{
					id: "abort",
					kind: "mutation",
					name: "liveSession.abort",
					input: {correlationId: "abort-1"},
					select: [],
				},
				{
					id: "model",
					kind: "mutation",
					name: "liveSession.setModel",
					input: {correlationId: "model-1", model: session.model},
					select: [],
				},
				{
					id: "thinking",
					kind: "mutation",
					name: "liveSession.setThinking",
					input: {correlationId: "thinking-1", thinkingLevel: session.thinkingLevel},
					select: [],
				},
			]);
			const body = (yield* resultOf(response)) as {
				results: Array<{ok: boolean; data: {correlationId?: string}}>;
			};
			assert.isTrue(body.results.every((result) => result.ok));
			assert.deepEqual(
				body.results.map((result) => result.data.correlationId),
				["create-1", "open-1", "steer-1", "abort-1", "model-1", "thinking-1"],
			);
			assert.deepEqual(calls, ["create", "open", "steer", "abort", "set-model", "set-thinking"]);
		}),
	);

	it.effect("round-trips every typed lineage projection arm through Fate", () =>
		Effect.gen(function* () {
			const root = sessionIdentity("root");
			const parent = sessionIdentity("parent");
			const child = sessionIdentity("child");
			const node = (id: string, source: string) => ({
				id: sessionIdentity(id),
				piSessionId: id,
				createdAt: 1,
				updatedAt: 2,
				cwd: "/tmp/tuval",
				sourceFiles: [source],
			});
			const lineage: LineageProjectionType = {
				graph: {
					version: 2,
					nodes: [
						node("child", "/tmp/child.jsonl"),
						node("parent", "/tmp/parent.jsonl"),
						node("root", "/tmp/root.jsonl"),
					],
					edges: [
						{id: `fork:${parent}`, kind: "fork", parent: root, child: parent, source: "protocol"},
						{
							id: "spawn:spawn-run",
							kind: "spawn",
							parent,
							child,
							runId: "spawn-run",
							observedAt: 10,
						},
					],
					continuity: [
						{id: "resume:resume-run", runId: "resume-run", session: child, parent, observedAt: 20},
					],
					ownership: [
						{
							kind: "observation",
							runId: "resume-run",
							session: child,
							parentReference: {kind: "run", value: "wrapper-run"},
							parent,
							observedAt: 20,
						},
						{
							kind: "observation",
							runId: "spawn-run",
							session: child,
							parentReference: {kind: "session", value: "/tmp/parent.jsonl"},
							parent,
							observedAt: 10,
						},
						{
							kind: "wrapper",
							runId: "wrapper-run",
							session: parent,
							parentReference: {kind: "none"},
							observedAt: 1,
						},
					],
				},
				problems: [
					{code: "retention-loss", source: "fixture", message: "missing source"},
					{
						code: "lock-cleanup-failed",
						source: "lineage.json.lock",
						message: "committed; operator cleanup required",
					},
				],
			};
			const live: LiveSessionService = {
				...makeUnavailableLiveSession(),
				current: () => Effect.succeed(null),
				attach: (sessionId) =>
					Effect.succeed({_tag: "refused", sessionId, code: "protocol", reason: "unused"}),
				prompt: ({correlationId}) =>
					Effect.succeed({_tag: "refused", correlationId, code: "no-attachment", reason: "unused"}),
				release: () => Effect.succeed({_tag: "released", sessionId: null}),
				eventsAfter: () => Effect.succeed([]),
				events: () => Stream.empty,
				dispose: () => Effect.void,
			};
			const response = yield* handle(
				live,
				[{id: "lineage", kind: "query", name: "lineage", select: []}],
				lineage,
			);
			const body = (yield* resultOf(response)) as {results: Array<{data?: unknown}>};
			const decoded = Schema.decodeUnknownSync(LineageProjection)(body.results[0]?.data);
			assert.deepEqual(decoded, lineage);
		}),
	);

	it.effect("rejects malformed mutation input before invoking the service", () =>
		Effect.gen(function* () {
			let called = false;
			const live: LiveSessionService = {
				...makeUnavailableLiveSession(),
				current: () => Effect.succeed(null),
				attach: () =>
					Effect.sync(() => {
						called = true;
						return {
							_tag: "refused" as const,
							sessionId: "never",
							code: "protocol" as const,
							reason: "never",
						};
					}),
				prompt: ({correlationId}) =>
					Effect.succeed({
						_tag: "refused",
						correlationId,
						code: "no-attachment",
						reason: "none",
					}),
				release: () => Effect.succeed({_tag: "released", sessionId: null}),
				eventsAfter: () => Effect.succeed([]),
				events: () => Stream.empty,
				dispose: () => Effect.void,
			};
			const response = yield* handle(live, [
				{
					id: "bad",
					kind: "mutation",
					name: "liveSession.attach",
					input: {sessionId: 42},
					select: [],
				},
			]);
			const responseBody = (yield* resultOf(response)) as {
				results: Array<{id: string; ok: boolean; error: {code: string}}>;
			};
			assert.strictEqual(responseBody.results[0]?.id, "bad");
			assert.isFalse(responseBody.results[0]?.ok ?? true);
			assert.strictEqual(responseBody.results[0]?.error.code, "VALIDATION_ERROR");
			assert.isFalse(called);
		}),
	);
});
