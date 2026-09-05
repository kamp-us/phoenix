/**
 * The `claude-session` row as a config module hands it over: what it declares, that the registry
 * spawns it, what its config schema defaults and refuses, and what a re-read config means for a
 * session already running.
 *
 * The layer under the row here is `ScriptedAiAgent`, because none of these facts is Claude's: they
 * are the row's own declarations, the schema's, and the generic core's. The Agent SDK layer is
 * proven in `agent/`, and the type of what this row hands the factory is pinned in
 * `boundary.unit.test.ts`.
 */

import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {applyCellChecked} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {afterAll, expect} from "vitest";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	aiAgentSessionMachine,
	initialState,
	isAiAgentSessionState,
} from "../ai-agent/core/index.ts";
import {aiAgentPortNames} from "../ai-agent/handlers/index.ts";
import {agentPorts, Mode} from "../ai-agent/ports/index.ts";
import {ScriptedAiAgent} from "../ai-agent/service/index.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {programEntries, showsInAWindow} from "../shell/picker/entries.ts";
import {
	CLAUDE_MODES,
	type ClaudeSessionConfigInput,
	claudeSessionSettings,
	DEFAULT_ALLOWED_TOOLS,
} from "./config.ts";
import {
	CLAUDE_SESSION_CAPABILITIES,
	CLAUDE_SESSION_PROGRAM,
	claudeSession,
	configChanged,
} from "./program.ts";
import {CLAUDE_CHAT_WINDOW_REF} from "./renderer-ref.ts";
import {wireNameOf} from "./tools/index.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const tempProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-claude-program-")));
	tempDirs.push(dir);
	return dir;
};

const CWD_UNDER_TEST = tempProject();

const script = {
	sessionId: "claude-program-test",
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
	interrupt: [],
	turns: [],
};

const row = (cwd: string, claude: ClaudeSessionConfigInput = {}) =>
	claudeSession({cwd, claude, layer: ScriptedAiAgent.layer(script)});

const kernel = (cwd: string) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(memoryStores())),
		Layer.provide(Registry.layer([row(cwd)])),
	);

describe("the claude-session program row", () => {
	it("declares one locally-placed row under the id a config module lists", () => {
		const declared = row(tempProject());
		assert.strictEqual(declared.id, ProgramId.make(CLAUDE_SESSION_PROGRAM));
		assert.strictEqual(declared.identity.program, CLAUDE_SESSION_PROGRAM);
		assert.deepStrictEqual(declared.placement, {host: "local"});
		assert.deepStrictEqual(declared.renderer, CLAUDE_CHAT_WINDOW_REF);
		assert.isFunction(
			declared.resume,
			"a restored Claude session has no way back without a resume",
		);
	});

	it("declares process-control and nothing else, because spawning is its own right (#7467)", () => {
		assert.deepStrictEqual(row(tempProject()).capabilities, CLAUDE_SESSION_CAPABILITIES);
		assert.deepStrictEqual(
			row(tempProject()).capabilities.map((request) => request.family),
			["process-control"],
		);
	});

	it("speaks the five AI agent ports and nothing else", () => {
		const ports = row(tempProject()).ports;
		assert.deepStrictEqual(Object.keys(ports).sort(), Object.values(aiAgentPortNames).sort());
		assert.deepStrictEqual(
			[...new Set(Object.values(ports).map((port) => port.kind))].sort(),
			agentPorts.map((port) => port.kind).sort(),
		);
	});

	it("shows in the picker, which is what declaring a renderer buys the row", () => {
		const declared = row(tempProject());
		assert.isTrue(showsInAWindow(declared));
		assert.deepStrictEqual(
			programEntries([declared]).map((entry) => entry.programId),
			[ProgramId.make(CLAUDE_SESSION_PROGRAM)],
			"a row the picker leaves out is a program nobody can open a window on",
		);
	});

	it.effect("spawns through the registry and opens its session in the project root", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(ProgramId.make(CLAUDE_SESSION_PROGRAM), {
				id: ProcessId.make("claude"),
				services: Context.empty(),
			});
			const state = handle.getState();
			assert.isTrue(isAiAgentSessionState(state), "the spawned process holds no session state");
			assert.strictEqual((state as AiAgentSessionState).cwd, CWD_UNDER_TEST);
			assert.isNull((state as AiAgentSessionState).sessionId);
		}).pipe(Effect.scoped, Effect.provide(kernel(CWD_UNDER_TEST))),
	);
});

describe("the config schema", () => {
	it("defaults the mode to default and the tools to the three tuval wire names", () => {
		const settings = claudeSessionSettings({});
		assert.strictEqual(settings.permissionMode, Mode.make("default"));
		assert.deepStrictEqual(settings.allowedTools, DEFAULT_ALLOWED_TOOLS);
		assert.isUndefined(settings.model);
	});

	it("defaults to the wire names the tool server actually serves", () => {
		assert.deepStrictEqual(DEFAULT_ALLOWED_TOOLS, [
			wireNameOf("spawn"),
			wireNameOf("send"),
			wireNameOf("read"),
		]);
	});

	it("refuses a bare tool name at decode, because a bare name skips canUseTool", () => {
		expect(() => claudeSessionSettings({allowedTools: ["Bash"]})).toThrow(/mcp__tuval__/);
	});

	it("takes an mcp__tuval__ name a config adds", () => {
		assert.deepStrictEqual(
			claudeSessionSettings({allowedTools: ["mcp__tuval__spawn"]}).allowedTools,
			["mcp__tuval__spawn"],
		);
	});

	it("refuses a mode outside the four the row offers", () => {
		expect(() => claudeSessionSettings({permissionMode: "bypassPermissions" as never})).toThrow();
	});

	it("fixes the mode list to default, acceptEdits, plan and auto", () => {
		assert.deepStrictEqual(
			claudeSessionSettings({}).modes,
			CLAUDE_MODES.map((m) => Mode.make(m)),
		);
		assert.deepStrictEqual(
			claudeSessionSettings({modes: ["plan"]} as ClaudeSessionConfigInput).modes,
			CLAUDE_MODES.map((m) => Mode.make(m)),
			"a config named its own mode list and the row took it",
		);
	});

	it("carries a model through when one is named", () => {
		assert.strictEqual(claudeSessionSettings({model: "claude-opus-5"}).model, "claude-opus-5");
	});
});

const machine = aiAgentSessionMachine({cwd: "/repo"});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

/** A live session advertising the four modes the row offers: what a `setMode` is admissible from. */
const ready: AiAgentSessionState = {
	...initialState("/repo"),
	phase: "ready",
	sessionId: "session-1",
	modes: {current: Mode.make("default"), available: CLAUDE_MODES.map((m) => Mode.make(m))},
};

describe("a config-changed reload", () => {
	it("maps a new permissionMode to exactly one setMode, and the core to one aiAgent.setMode", () => {
		const previous = claudeSessionSettings({});
		const next = claudeSessionSettings({permissionMode: "plan"});
		const messages = configChanged(previous, next);
		assert.deepStrictEqual(messages, [{type: "setMode", mode: Mode.make("plan")}]);
		const [, cmds] = apply(ready, messages[0] as AiAgentSessionMsg);
		assert.deepStrictEqual(cmds, [{type: "aiAgent.setMode", mode: Mode.make("plan")}]);
	});

	it("dispatches nothing for any other changed field", () => {
		const previous = claudeSessionSettings({});
		assert.deepStrictEqual(
			configChanged(previous, claudeSessionSettings({model: "claude-opus-5"})),
			[],
		);
		assert.deepStrictEqual(
			configChanged(previous, claudeSessionSettings({allowedTools: ["mcp__tuval__read"]})),
			[],
		);
		assert.deepStrictEqual(configChanged(previous, claudeSessionSettings({})), []);
	});
});
