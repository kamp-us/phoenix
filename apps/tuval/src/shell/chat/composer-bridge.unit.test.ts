/**
 * The composer seam, with no DOM. `AgentChatInput` reads its whole world off this object, so what
 * it answers decides whether the send button is enabled, whether Escape interrupts, whether the
 * model picker is enabled and which row it shows selected — and every one of those is decidable
 * here.
 */

import {describe, expect, it, vi} from "vitest";
import type {ModelState} from "../../ai-agent/core/index.ts";
import type {ModelRef} from "../../ai-agent/ports/index.ts";
import {composerBridge} from "./composer-bridge.ts";

const opus: ModelRef = {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"};
const sonnet: ModelRef = {provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"};
/** A backend that names no provider — Claude's catalog rows are a bare id and a label. */
const bare: ModelRef = {id: "haiku", name: "Haiku"};

const noModels: ModelState = {current: null, available: []};

const seam = () => {
	const onPrompt = vi.fn<(text: string) => void>();
	const onInterrupt = vi.fn<() => void>();
	const onSetModel = vi.fn<(model: ModelRef) => void>();
	return {onPrompt, onInterrupt, onSetModel, initialModels: noModels};
};

describe("composerBridge", () => {
	it("turns a send into one prompt and a stop into one interrupt", async () => {
		const handlers = seam();
		const {bridge} = composerBridge({...handlers, initialPhase: "ready"});
		await bridge.sendPiPrompt({type: "prompt", message: "build it"});
		await bridge.abortPi();
		expect(handlers.onPrompt.mock.calls).toEqual([["build it"]]);
		expect(handlers.onInterrupt.mock.calls).toEqual([[]]);
	});

	it("reports the session as streaming exactly while a turn is running", async () => {
		const working = composerBridge({...seam(), initialPhase: "prompting"});
		const ready = composerBridge({...seam(), initialPhase: "ready"});
		expect(await working.bridge.loadPiState()).toEqual({isStreaming: true});
		expect(await ready.bridge.loadPiState()).toEqual({isStreaming: false});
	});

	it("pushes a start and a settle as the phase crosses into and out of a turn", () => {
		const composer = composerBridge({...seam(), initialPhase: "ready"});
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
		const composer = composerBridge({...seam(), initialPhase: "ready"});
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
		const {bridge} = composerBridge({...seam(), initialPhase: "ready"});
		expect(await bridge.loadPiCommands()).toEqual([]);
		expect(await bridge.loadPiThinkingLevels()).toEqual([]);
		expect(await bridge.loadPiFiles("src")).toEqual([]);
		expect(await bridge.setPiThinkingLevel("high")).toBeUndefined();
		expect(await bridge.setPiProjectTrust("approve")).toBeUndefined();
		expect(await bridge.answerPiExtension({id: "r1"})).toBeUndefined();
		// Models it does have (#7981), and an agent offering none still answers empty rather than
		// rejecting: a rejection puts the composer in `unavailable` and disables the send button.
		expect(await bridge.loadPiModels()).toEqual([]);
		expect(await bridge.setPiModel({provider: "x", id: "y", name: "Y"})).toBeUndefined();
	});

	it("answers the picker with the session's offered list and its current model", async () => {
		const composer = composerBridge({
			...seam(),
			initialPhase: "ready",
			initialModels: {current: sonnet, available: [opus, sonnet]},
		});
		expect(await composer.bridge.loadPiModels()).toEqual([
			{provider: "anthropic", id: "claude-opus-5", name: "Opus 5"},
			{provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"},
		]);
		expect(await composer.bridge.loadPiState()).toEqual({
			isStreaming: false,
			model: {provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"},
		});
	});

	it("names a provider-less model under one that cannot collide with a real provider", async () => {
		const composer = composerBridge({
			...seam(),
			initialPhase: "ready",
			initialModels: {current: bare, available: [bare]},
		});
		expect(await composer.bridge.loadPiModels()).toEqual([
			{provider: "agent", id: "haiku", name: "Haiku"},
		]);
	});

	it("pushes a catalog that arrives after mount instead of rebuilding the bridge", async () => {
		const composer = composerBridge({...seam(), initialPhase: "ready"});
		const seen: Array<unknown> = [];
		composer.bridge.subscribeToPiEvents(
			(event) => seen.push(event),
			() => undefined,
		);
		expect(await composer.bridge.loadPiModels()).toEqual([]);
		composer.setModels({current: opus, available: [opus, sonnet]});
		expect(seen).toEqual([
			{
				type: "harness_status",
				status: {
					models: [
						{provider: "anthropic", id: "claude-opus-5", name: "Opus 5"},
						{provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"},
					],
					model: {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"},
				},
			},
		]);
		expect((await composer.bridge.loadPiModels()).length).toBe(2);
	});

	it("turns a pick into one setModel carrying the session's own ref", async () => {
		const handlers = seam();
		const composer = composerBridge({
			...handlers,
			initialPhase: "ready",
			initialModels: {current: opus, available: [opus, sonnet]},
		});
		// The picker sends back the label it rendered; what leaves is the ref the session offered.
		await composer.bridge.setPiModel({provider: "anthropic", id: "claude-sonnet-5", name: "!"});
		expect(handlers.onSetModel.mock.calls).toEqual([[sonnet]]);
	});

	it("drops a pick the session does not offer rather than rejecting it", async () => {
		const handlers = seam();
		const composer = composerBridge({
			...handlers,
			initialPhase: "ready",
			initialModels: {current: opus, available: [opus]},
		});
		expect(
			await composer.bridge.setPiModel({provider: "openai", id: "gpt", name: "GPT"}),
		).toBeUndefined();
		expect(handlers.onSetModel.mock.calls).toEqual([]);
	});
});
