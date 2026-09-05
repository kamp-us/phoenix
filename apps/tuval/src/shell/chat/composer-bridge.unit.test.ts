/**
 * The composer seam, with no DOM. `AgentChatInput` reads its whole world off this object, so what
 * it answers decides whether the send button is enabled, whether Escape interrupts, and whether the
 * composer sits in its `unavailable` state — and every one of those is decidable here.
 */

import {describe, expect, it, vi} from "vitest";
import {composerBridge} from "./composer-bridge.ts";

const handlers = () => {
	const onPrompt = vi.fn<(text: string) => void>();
	const onInterrupt = vi.fn<() => void>();
	return {onPrompt, onInterrupt};
};

describe("composerBridge", () => {
	it("turns a send into one prompt and a stop into one interrupt", async () => {
		const {onPrompt, onInterrupt} = handlers();
		const {bridge} = composerBridge({onPrompt, onInterrupt, initialPhase: "ready"});
		await bridge.sendPiPrompt({type: "prompt", message: "build it"});
		await bridge.abortPi();
		expect(onPrompt.mock.calls).toEqual([["build it"]]);
		expect(onInterrupt.mock.calls).toEqual([[]]);
	});

	it("reports the session as streaming exactly while a turn is running", async () => {
		const {onPrompt, onInterrupt} = handlers();
		const working = composerBridge({onPrompt, onInterrupt, initialPhase: "prompting"});
		const ready = composerBridge({onPrompt, onInterrupt, initialPhase: "ready"});
		expect(await working.bridge.loadPiState()).toEqual({isStreaming: true});
		expect(await ready.bridge.loadPiState()).toEqual({isStreaming: false});
	});

	it("pushes a start and a settle as the phase crosses into and out of a turn", () => {
		const {onPrompt, onInterrupt} = handlers();
		const composer = composerBridge({onPrompt, onInterrupt, initialPhase: "ready"});
		const seen: Array<string> = [];
		composer.bridge.subscribeToPiEvents(
			(event) => seen.push(event.type),
			() => undefined,
		);
		composer.setPhase("prompting");
		composer.setPhase("prompting");
		composer.setPhase("ready");
		composer.setPhase("starting");
		expect(seen).toEqual(["agent_start", "agent_settled"]);
	});

	it("stops pushing once the composer unsubscribes", () => {
		const {onPrompt, onInterrupt} = handlers();
		const composer = composerBridge({onPrompt, onInterrupt, initialPhase: "ready"});
		const seen: Array<string> = [];
		const off = composer.bridge.subscribeToPiEvents(
			(event) => seen.push(event.type),
			() => undefined,
		);
		off();
		composer.setPhase("prompting");
		expect(seen).toEqual([]);
	});

	it("answers every capability it does not have as empty, never as a rejection", async () => {
		const {onPrompt, onInterrupt} = handlers();
		const {bridge} = composerBridge({onPrompt, onInterrupt, initialPhase: "ready"});
		expect(await bridge.loadPiCommands()).toEqual([]);
		expect(await bridge.loadPiModels()).toEqual([]);
		expect(await bridge.loadPiThinkingLevels()).toEqual([]);
		expect(await bridge.loadPiFiles("src")).toEqual([]);
		expect(await bridge.setPiModel({provider: "x", id: "y", name: "Y"})).toBeUndefined();
		expect(await bridge.setPiThinkingLevel("high")).toBeUndefined();
		expect(await bridge.setPiProjectTrust("approve")).toBeUndefined();
		expect(await bridge.answerPiExtension({id: "r1"})).toBeUndefined();
	});
});
