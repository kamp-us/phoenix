import {aiAgentBackends} from "@kampus/tuval-sdk/kernel/ai-agent/backends";
import {aiAgentPortNames} from "@kampus/tuval-sdk/kernel/ai-agent/handlers/index";
import {AI_AGENT_INSPECTOR_REF} from "@kampus/tuval-sdk/kernel/ai-agent/renderer-ref";
import {emptySession} from "@kampus/tuval-sdk/kernel/ai-agent/service/fixtures/scripts";
import {ScriptedAiAgent, type TuvalAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import type {KernelBridge} from "@kampus/tuval-sdk/kernel/ai-agent/tools/KernelBridge";
import type {Layer} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {CodexAiAgent} from "./CodexAiAgent.ts";
import {codexSessionSettings} from "./config.ts";
import {codexSession} from "./program.ts";
import {CODEX_CHAT_WINDOW_REF} from "./renderer-ref.ts";

const row = (mode: "workspace-write" | "read-only" = "workspace-write") =>
	codexSession({cwd: "/tmp/codex", codex: {mode}, layer: ScriptedAiAgent.layer(emptySession)});

describe("Codex is a sibling program", () => {
	it("uses the shared ports, inspector, session discovery and restore", () => {
		const codex = row();
		expect(Object.keys(codex.ports).sort()).toEqual(Object.values(aiAgentPortNames).sort());
		expect(codex.inspector).toEqual(AI_AGENT_INSPECTOR_REF);
		expect(codex.renderer).toEqual(CODEX_CHAT_WINDOW_REF);
		expect(codex.resume).toBeTypeOf("function");
		expect(aiAgentBackends([codex])).toHaveLength(1);
	});
	it("requires only the same kernel bridge, with no Codex value in the service", () => {
		expectTypeOf<ReturnType<typeof CodexAiAgent.layer>>().toEqualTypeOf<
			Layer.Layer<TuvalAiAgent, never, KernelBridge>
		>();
	});
	it("defaults to bounded workspace access and rejects full-access configuration", () => {
		expect(codexSessionSettings({})).toEqual({
			mode: "workspace-write",
			streamPartialReplies: false,
		});
		expect(() => codexSessionSettings({mode: "danger-full-access"})).toThrow();
	});
	it("uses the generic mode message for config reload", () => {
		expect(row().configChanged?.(row("read-only"))).toEqual([{type: "setMode", mode: "read-only"}]);
		expect(row().configChanged?.(row())).toEqual([]);
	});
});
