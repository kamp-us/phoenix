/** @vitest-environment jsdom */
import {ClientDisposedError, DisconnectedError, ServerError} from "@earendil-works/pi-client";
import {render, screen} from "@testing-library/react";
import {Effect, Schema} from "effect";
import type {ReactElement} from "react";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {failureOf} from "../../ai-agent/handlers/failures.ts";
import {TranscriptError} from "../../ai-agent/service/index.ts";
import {ProcessId} from "../../process/process.ts";
import {chatWindow} from "../../shell/chat/ChatWindow.tsx";
import {sessionState} from "../../shell/chat/chat.testing.ts";
import {type ChatView, initialChatView} from "../../shell/chat/view.ts";
import {installDomShims} from "../../shell/ui/dom.testing.ts";
import {testProcess} from "../../shell/window/fixtures.ts";
import {WindowId} from "../../shell/window/index.ts";
import {
	interruptFailureOf,
	promptDropOf,
	promptErrorOf,
	promptFailureOf,
	startErrorOf,
	storeUnlistable,
	storeUnreadable,
	transcriptUnreadable,
	transportErrorOf,
} from "../ai-agent/refusals.ts";
import {Disconnected, ProtocolRefused} from "../client/errors.ts";
import {connectionRefusalOf, sessionRefusalOf} from "../client/refusals.ts";

installDomShims();
const sentinel = "SYNTHETIC-PRIVATE-DIAGNOSTIC-8509";
const thrown = new Error(sentinel);

describe("Pi exception translation into checkpointed/rendered failure data", () => {
	it.each([
		thrown,
		sentinel,
		{detail: sentinel},
	])("keeps an arbitrary cause local at every generic operation: %j", (cause) => {
		const client = connectionRefusalOf(cause);
		expect(client.cause).toBe(cause);
		expect(client.detail).not.toContain(sentinel);
		const start = startErrorOf("/workspace", client);
		const prompt = promptErrorOf(client);
		const errors = [
			start,
			prompt,
			storeUnreadable(cause),
			promptDropOf(prompt),
			transportErrorOf(new Disconnected({detail: sentinel})),
		];
		for (const error of errors) {
			expect(error.cause).toBeDefined();
			expect(error.detail).toContain("Pi");
			expect(JSON.stringify(failureOf(error))).not.toContain(sentinel);
		}
		expect(storeUnlistable([{store: "tuval", cause}]).cause).toEqual([{store: "tuval", cause}]);
		expect(start.cause).toBe(client);
		expect(prompt.cause).toBe(client);
		expect(storeUnreadable(cause).cause).toBe(cause);
		expect(transcriptUnreadable("session", cause).cause).toBe(cause);
		expect(
			JSON.stringify(Schema.encodeSync(TranscriptError)(transcriptUnreadable("session", cause))),
		).not.toContain(sentinel);
		expect(JSON.stringify(promptFailureOf(prompt))).not.toContain(sentinel);
		expect(JSON.stringify(interruptFailureOf(client, true))).not.toContain(sentinel);
		expect(interruptFailureOf(client, false).reason).toBe("no-live-turn");
	});

	it("routes only pinned classes and owned codes, never text that resembles a diagnosis", () => {
		expect(connectionRefusalOf(new DisconnectedError(sentinel))._tag).toBe(
			"tuval/pi/client/Disconnected",
		);
		expect(connectionRefusalOf(new ClientDisposedError())._tag).toBe(
			"tuval/pi/client/Disconnected",
		);
		for (const [code, reason] of [
			["session_locked", "session-locked"],
			["not_found", "session-not-found"],
		] as const) {
			const original = new ServerError({code, message: sentinel});
			const refusal = sessionRefusalOf("session", original);
			expect(refusal.cause).toBe(original);
			expect(startErrorOf("/workspace", refusal).reason).toBe(reason);
		}
		const impostor = new Error(`session_locked invalid API key billing ${sentinel}`);
		expect(startErrorOf("/workspace", connectionRefusalOf(impostor)).detail).toBe(
			"Pi could not start or resume the session: the Pi server refused the request",
		);
		const unknown = new ProtocolRefused({code: sentinel, detail: sentinel});
		expect(JSON.stringify(failureOf(promptErrorOf(unknown)))).not.toContain(sentinel);
	});

	it("renders only the deliberate failure and checkpoints no local diagnostic", async () => {
		const refusal = connectionRefusalOf(thrown);
		const error = startErrorOf("/workspace", refusal);
		const state = sessionState({phase: "idle", failure: failureOf(error)});
		expect(JSON.stringify(state)).not.toContain(sentinel);
		expect(error.cause).toBe(refusal);
		expect(refusal.cause).toBe(thrown);
		const process = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(ProcessId.make("exception"), state),
		);
		const host = await Effect.runPromise(
			process.window<ChatView>(WindowId.make("exception"), initialChatView),
		);
		render(chatWindow({scrollToFn: () => {}}).render(host) as ReactElement);
		expect(screen.getByText(/Pi could not start or resume the session/)).toBeDefined();
		expect(document.body.textContent).not.toContain(sentinel);
	});
});
