import {describe, expect, it} from "@effect/vitest";
import {
	type CurrentUser,
	FateInterpreter,
	type LivePublisher,
	type LiveTopicPublisher,
} from "@kampus/fate-effect";
import {Effect, Layer, Stream} from "effect";
import {TuvalFateServerLive} from "../src/backend/fate.js";
import {LiveSession, type LiveSessionService} from "../src/backend/live-session.js";
import {PiDiscovery} from "../src/backend/pi-discovery.js";
import type {LiveSessionView} from "../src/shared/live-session.js";
import {tryPromise} from "./test-effect.js";

const session: LiveSessionView = {
	_tag: "attached",
	sessionId: "session-one",
	revision: 1,
	phase: "idle",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	completion: "idle",
	transcript: [],
	lastEventSequence: 1,
	connection: "connected",
	ownership: "exclusive",
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

const handle = (live: LiveSessionService, operations: ReadonlyArray<Record<string, unknown>>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const app = yield* Layer.build(
				TuvalFateServerLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.succeed(LiveSession, live),
							Layer.succeed(PiDiscovery, {
								discover: () => Effect.succeed({_tag: "empty", sessions: [] as const}),
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
			let current: LiveSessionView | null = null;
			const live: LiveSessionService = {
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
			expect(yield* resultOf(attached)).toMatchObject({
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
			]);
			expect(yield* resultOf(response)).toMatchObject({
				results: [
					{id: "current", ok: true, data: session},
					{id: "prompt", ok: true, data: {_tag: "acknowledged", correlationId: "prompt-1"}},
				],
			});

			yield* handle(live, [
				{
					id: "release",
					kind: "mutation",
					name: "liveSession.release",
					input: {},
					select: [],
				},
			]);
			expect(calls).toEqual(["attach:session-one", "prompt:prompt-1:hello", "release"]);
		}),
	);

	it.effect("rejects malformed mutation input before invoking the service", () =>
		Effect.gen(function* () {
			let called = false;
			const live: LiveSessionService = {
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
			expect(yield* resultOf(response)).toMatchObject({
				results: [{id: "bad", ok: false, error: {code: "VALIDATION_ERROR"}}],
			});
			expect(called).toBe(false);
		}),
	);
});
