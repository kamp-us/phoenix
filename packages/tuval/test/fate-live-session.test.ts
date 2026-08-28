import {describe, expect, it} from "vitest";
import {makeFateServer} from "../src/backend/fate.js";
import type {LiveSessionService} from "../src/backend/live-session.js";
import type {LiveSessionEvent, LiveSessionView} from "../src/shared/live-session.js";

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

const resultOf = async (response: Response): Promise<unknown> => response.json();

describe("live-session fate contract", () => {
	it("exposes attach, current state, correlated prompt, events, and release", async () => {
		const calls: Array<string> = [];
		const event: LiveSessionEvent = {_tag: "session", sequence: 1, session};
		let current: LiveSessionView | null = null;
		const live: LiveSessionService = {
			current: () => current,
			attach: async (sessionId) => {
				calls.push(`attach:${sessionId}`);
				current = session;
				return {_tag: "attached", session};
			},
			prompt: async ({correlationId, text}) => {
				calls.push(`prompt:${correlationId}:${text}`);
				return {_tag: "acknowledged", correlationId, session};
			},
			release: async () => {
				calls.push("release");
				current = null;
				return {_tag: "released", sessionId: session.sessionId};
			},
			eventsAfter: (sequence = 0) => (sequence < 1 ? [event] : []),
			subscribe: () => () => {},
			dispose: async () => {},
		};
		const fate = makeFateServer(async () => ({_tag: "empty", sessions: []}), live);

		await expect(
			resultOf(
				await fate.handleRequest(
					request([
						{
							id: "attach",
							kind: "mutation",
							name: "liveSession.attach",
							input: {sessionId: session.sessionId},
							select: [],
						},
					]),
				),
			),
		).resolves.toMatchObject({
			results: [{id: "attach", ok: true, data: {_tag: "attached", session}}],
		});

		const response = await fate.handleRequest(
			request([
				{id: "current", kind: "query", name: "liveSession.current", select: []},
				{
					id: "events",
					kind: "query",
					name: "liveSession.events",
					args: {afterSequence: 0},
					select: [],
				},
				{
					id: "prompt",
					kind: "mutation",
					name: "liveSession.prompt",
					input: {correlationId: "prompt-1", text: "hello"},
					select: [],
				},
			]),
		);
		await expect(resultOf(response)).resolves.toMatchObject({
			results: [
				{id: "current", ok: true, data: session},
				{id: "events", ok: true, data: [event]},
				{
					id: "prompt",
					ok: true,
					data: {_tag: "acknowledged", correlationId: "prompt-1"},
				},
			],
		});

		await fate.handleRequest(
			request([
				{
					id: "release",
					kind: "mutation",
					name: "liveSession.release",
					input: {},
					select: [],
				},
			]),
		);
		expect(calls).toEqual(["attach:session-one", "prompt:prompt-1:hello", "release"]);
	});

	it("rejects malformed mutation input before invoking the live service", async () => {
		let called = false;
		const live: LiveSessionService = {
			current: () => null,
			attach: async () => {
				called = true;
				return {
					_tag: "refused",
					sessionId: "never",
					code: "protocol",
					reason: "never",
				};
			},
			prompt: async ({correlationId}) => ({
				_tag: "refused",
				correlationId,
				code: "no-attachment",
				reason: "none",
			}),
			release: async () => ({_tag: "released", sessionId: null}),
			eventsAfter: () => [],
			subscribe: () => () => {},
			dispose: async () => {},
		};
		const fate = makeFateServer(async () => ({_tag: "empty", sessions: []}), live);
		const response = await resultOf(
			await fate.handleRequest(
				request([
					{
						id: "bad",
						kind: "mutation",
						name: "liveSession.attach",
						input: {sessionId: 42},
						select: [],
					},
				]),
			),
		);
		expect(response).toMatchObject({
			results: [{id: "bad", ok: false, error: {code: "VALIDATION_ERROR"}}],
		});
		expect(called).toBe(false);
	});
});
