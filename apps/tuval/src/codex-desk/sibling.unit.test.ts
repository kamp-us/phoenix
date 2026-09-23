/**
 * The `codex-session` row beside the `claude-session` row, as the desk holds them: the two share
 * one port set and one kernel bridge, both register as AI-agent backends, and the desk's picker
 * lists Codex. Each case reads both harness packages or the desk's picker, so they live beside the
 * desk rather than in `@kampus/tuval-codex`, whose own tests cover the row alone.
 */

import {claudeSession} from "@kampus/tuval-claude";
import {KernelBridge as ClaudeKernelBridge} from "@kampus/tuval-claude/tools";
import {codexSession} from "@kampus/tuval-codex";
import {aiAgentBackends} from "@kampus/tuval-sdk/kernel/ai-agent/backends";
import {emptySession} from "@kampus/tuval-sdk/kernel/ai-agent/service/fixtures/scripts";
import {ScriptedAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {KernelBridge} from "@kampus/tuval-sdk/kernel/ai-agent/tools/KernelBridge";
import {describe, expect, it} from "vitest";
import {programEntries} from "../shell/picker/entries.ts";

const layer = ScriptedAiAgent.layer(emptySession);

describe("Codex is a sibling of Claude on the desk", () => {
	it("shares Claude's ports, registers beside it and shows in the picker", () => {
		const codex = codexSession({cwd: "/tmp/codex", codex: {mode: "workspace-write"}, layer});
		const claude = claudeSession({cwd: "/tmp/codex", layer});
		expect(codex.ports).toEqual(claude.ports);
		expect(aiAgentBackends([codex, claude])).toHaveLength(2);
		expect(programEntries([codex]).map((entry) => entry.programId)).toEqual(["codex-session"]);
	});
	it("requires the same kernel bridge Claude's tools serve", () => {
		expect(ClaudeKernelBridge).toBe(KernelBridge);
	});
});
