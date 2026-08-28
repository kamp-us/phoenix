import {NodeServices} from "@effect/platform-node";
import {Effect, Exit, Scope, Stream} from "effect";
import {describe, expect, it} from "vitest";
import type {LiveSessionService} from "../src/backend/live-session.js";
import {startTuval} from "../src/backend/server.js";
import type {LiveSessionEvent} from "../src/shared/live-session.js";

const event: LiveSessionEvent = {
	_tag: "diagnostic",
	sequence: 2,
	sessionId: null,
	message: "streamed from the live session",
};

const liveSession: LiveSessionService = {
	current: () => Effect.succeed(null),
	attach: (sessionId) =>
		Effect.succeed({
			_tag: "refused",
			sessionId,
			code: "disconnected",
			reason: "not used",
		}),
	prompt: ({correlationId}) =>
		Effect.succeed({
			_tag: "refused",
			correlationId,
			code: "no-attachment",
			reason: "not used",
		}),
	release: () => Effect.succeed({_tag: "released", sessionId: null}),
	eventsAfter: (sequence = 0) => Effect.succeed(sequence < event.sequence ? [event] : []),
	events: (sequence = 0) => Stream.fromIterable(sequence < event.sequence ? [event] : []),
	dispose: () => Effect.void,
};

describe("live-session server transport", () => {
	it("streams ordered service events over /fate/live without a polling query", async () => {
		const scope = await Effect.runPromise(Scope.make());
		const server = await Effect.runPromise(
			startTuval({
				liveSession,
				openBrowser: () => Effect.void,
			}).pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(NodeServices.layer)),
		);
		const abort = new AbortController();
		try {
			const response = await fetch(`${server.url}/fate/live?afterSequence=1`, {
				signal: abort.signal,
			});
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const chunk = await response.body?.getReader().read();
			expect(new TextDecoder().decode(chunk?.value)).toContain(`data: ${JSON.stringify(event)}`);
		} finally {
			abort.abort();
			await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
		}
	});
});
