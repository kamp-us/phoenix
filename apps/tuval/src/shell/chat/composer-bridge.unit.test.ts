/**
 * The composer seam, with no DOM. `AgentChatInput` reads its whole world off this object, so what
 * it answers decides whether the send button is enabled, whether Escape interrupts, whether the
 * model picker is enabled and which row it shows selected — and every one of those is decidable
 * here.
 */

import {describe, expect, it, vi} from "vitest";
import type {ModelState, ThinkingState} from "../../ai-agent/core/index.ts";
import type {CommandRef, ModelRef, ThinkingLevel} from "../../ai-agent/ports/index.ts";
import {composerBridge} from "./composer-bridge.ts";

const opus: ModelRef = {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"};
const sonnet: ModelRef = {provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"};
/** A backend that names no provider — Claude's catalog rows are a bare id and a label. */
const bare: ModelRef = {id: "haiku", name: "Haiku"};

const noModels: ModelState = {current: null, available: []};
const noThinking: ThinkingState = {current: null, available: []};

/** The Claude window's offered set: five levels, no `off` and no `minimal` (#8062). */
const effort: ThinkingState = {
	current: "medium",
	available: ["low", "medium", "high", "xhigh", "max"],
};

const compact: CommandRef = {name: "compact", description: "Summarise the conversation."};
const review: CommandRef = {name: "skill:review", description: "Review it.", argumentHint: "<pr>"};

const seam = () => {
	const onPrompt = vi.fn<(text: string) => void>();
	const onInterrupt = vi.fn<() => void>();
	const onSetModel = vi.fn<(model: ModelRef) => void>();
	const onSetThinkingLevel = vi.fn<(level: ThinkingLevel) => void>();
	return {
		onPrompt,
		onInterrupt,
		onSetModel,
		onSetThinkingLevel,
		initialModels: noModels,
		initialCommands: [],
		initialThinking: noThinking,
	};
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

	it("answers an unheld capability, and a held empty one, empty not rejected", async () => {
		const {bridge} = composerBridge({...seam(), initialPhase: "ready"});
		expect(await bridge.loadPiFiles("src")).toEqual([]);
		expect(await bridge.setPiProjectTrust("approve")).toBeUndefined();
		expect(await bridge.answerPiExtension({id: "r1"})).toBeUndefined();
		// Models (#7981), commands (#8060) and thinking levels (#8062) it does have, and an agent
		// offering none still answers empty rather than rejecting: a rejection puts the composer in
		// `unavailable` and disables the send button.
		expect(await bridge.loadPiModels()).toEqual([]);
		expect(await bridge.setPiModel({provider: "x", id: "y", name: "Y"})).toBeUndefined();
		expect(await bridge.loadPiThinkingLevels()).toEqual([]);
		expect(await bridge.setPiThinkingLevel("high")).toBeUndefined();
		// Commands too (#8060), and a backend offering none answers the same empty list — which is
		// exactly Pi's answer while `pi-protocol` carries no command catalog.
		expect(await bridge.loadPiCommands()).toEqual([]);
	});

	it("answers the picker with the session's own command catalog", async () => {
		const composer = composerBridge({
			...seam(),
			initialPhase: "ready",
			initialCommands: [compact, review],
		});
		// `argumentHint` is the session's, not the picker's: the composer inserts the command and the
		// operator types the arguments, so a hint rendered as description would misread as one.
		expect(await composer.bridge.loadPiCommands()).toEqual([
			{name: "compact", description: "Summarise the conversation."},
			{name: "skill:review", description: "Review it."},
		]);
	});

	it("replaces the catalog a later push carries instead of merging into it", async () => {
		const composer = composerBridge({
			...seam(),
			initialPhase: "ready",
			initialCommands: [compact, review],
		});
		composer.setCommands([review]);
		expect(await composer.bridge.loadPiCommands()).toEqual([
			{name: "skill:review", description: "Review it."},
		]);
	});

	it("answers the thinking picker with the session's offered levels and its current one", async () => {
		const composer = composerBridge({
			...seam(),
			initialPhase: "ready",
			initialThinking: effort,
		});
		expect(await composer.bridge.loadPiThinkingLevels()).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(await composer.bridge.loadPiState()).toEqual({
			isStreaming: false,
			thinkingLevel: "medium",
		});
	});

	it("turns a level the session offers into one setThinkingLevel", async () => {
		const handlers = seam();
		const composer = composerBridge({
			...handlers,
			initialPhase: "ready",
			initialThinking: effort,
		});
		await composer.bridge.setPiThinkingLevel("xhigh");
		expect(handlers.onSetThinkingLevel.mock.calls).toEqual([["xhigh"]]);
	});

	it("drops a level the session does not offer rather than rejecting it", async () => {
		const handlers = seam();
		const composer = composerBridge({
			...handlers,
			initialPhase: "ready",
			initialThinking: effort,
		});
		// `minimal` is in the design vocabulary and not in Claude's offered set, which is the whole
		// shape of the founder's per-backend ruling.
		expect(await composer.bridge.setPiThinkingLevel("minimal")).toBeUndefined();
		expect(handlers.onSetThinkingLevel.mock.calls).toEqual([]);
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

	it("pushes both catalogs that arrive after mount instead of rebuilding the bridge", async () => {
		const composer = composerBridge({...seam(), initialPhase: "ready"});
		const seen: Array<unknown> = [];
		composer.bridge.subscribeToPiEvents(
			(event) => seen.push(event),
			() => undefined,
		);
		expect(await composer.bridge.loadPiModels()).toEqual([]);
		expect(await composer.bridge.loadPiThinkingLevels()).toEqual([]);
		composer.setModels({current: opus, available: [opus, sonnet]});
		composer.setThinking(effort);
		// Pushed events, not a second bridge: the composer re-runs its whole load on a new bridge
		// identity, so a rebuild here would drop it back into `loading` (#8062). Each push carries
		// every catalog, so the last one is the whole picture.
		expect(seen.length).toBe(2);
		expect(seen[1]).toEqual({
			type: "harness_status",
			status: {
				models: [
					{provider: "anthropic", id: "claude-opus-5", name: "Opus 5"},
					{provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"},
				],
				commands: [],
				model: {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"},
				thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
				thinkingLevel: "medium",
			},
		});
		expect((await composer.bridge.loadPiModels()).length).toBe(2);
		expect((await composer.bridge.loadPiThinkingLevels()).length).toBe(5);
	});

	it("replays a level set that landed before the composer subscribed", async () => {
		const composer = composerBridge({...seam(), initialPhase: "ready"});
		composer.setThinking(effort);
		const seen: Array<unknown> = [];
		composer.bridge.subscribeToPiEvents(
			(event) => seen.push(event),
			() => undefined,
		);
		// The composer subscribes after its loads resolve, so a set that landed in between was
		// pushed at a listener that did not exist yet; on a session nobody switches, no second
		// event ever comes.
		expect(seen).toEqual([
			{
				type: "harness_status",
				status: {
					models: [],
					commands: [],
					thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
					thinkingLevel: "medium",
				},
			},
		]);
	});

	it("pushes a command catalog that arrives after mount on the same subscription", async () => {
		const composer = composerBridge({...seam(), initialPhase: "ready"});
		const seen: Array<unknown> = [];
		composer.bridge.subscribeToPiEvents(
			(event) => seen.push(event),
			() => undefined,
		);
		composer.setCommands([compact]);
		expect(seen).toEqual([
			{
				type: "harness_status",
				status: {
					models: [],
					commands: [{name: "compact", description: "Summarise the conversation."}],
					thinkingLevels: [],
				},
			},
		]);
	});

	it("re-pushes a catalog that landed before the composer subscribed", () => {
		const composer = composerBridge({
			...seam(),
			initialPhase: "ready",
			initialCommands: [compact],
		});
		const seen: Array<unknown> = [];
		composer.bridge.subscribeToPiEvents(
			(event) => seen.push(event),
			() => undefined,
		);
		expect(seen).toEqual([
			{
				type: "harness_status",
				status: {
					models: [],
					commands: [{name: "compact", description: "Summarise the conversation."}],
					thinkingLevels: [],
				},
			},
		]);
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

	it("resolves each of two providers' same-named models to its own ref", async () => {
		const handlers = seam();
		const openaiLuna: ModelRef = {provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna"};
		const codexLuna: ModelRef = {
			provider: "openai-codex",
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
		};
		const composer = composerBridge({
			...handlers,
			initialPhase: "ready",
			initialModels: {current: openaiLuna, available: [openaiLuna, codexLuna]},
		});

		await composer.bridge.setPiModel({provider: "openai-codex", id: "gpt-5.6-luna", name: "!"});
		await composer.bridge.setPiModel({provider: "openai", id: "gpt-5.6-luna", name: "!"});

		expect(handlers.onSetModel.mock.calls).toEqual([[codexLuna], [openaiLuna]]);
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
