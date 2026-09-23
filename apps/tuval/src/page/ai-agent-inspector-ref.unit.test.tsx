/**
 * @vitest-environment jsdom
 *
 * The shared ai-agent inspector as the page binds it. It builds the snapshot out of the **real**
 * `claude-session` and `pi-session` rows and the **real** page inspector table, so what it proves is
 * that a reference a row declares resolves to the renderer the page binds — not that two
 * hand-written tables agree with each other. Both rows and the table are imported; nothing here
 * restates a reference. What the panel itself shows is proven in `@kampus/tuval-ui`'s own
 * `ai-agent-inspector.unit.test.tsx`.
 */

import {claudeSession} from "@kampus/tuval-claude";
import type {
	AiAgentSessionMsg,
	AiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {ScriptedAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {testProcess} from "@kampus/tuval-sdk/kernel/shell/window/fixtures";
import {type AnyWindowHost, WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {AiAgentInspector} from "@kampus/tuval-ui/agent-window";
import {inspectorFor} from "@kampus/tuval-ui/desk";
import {deskSnapshot} from "@kampus/tuval-ui/testing/desk";
import {agentSessionState, CWD} from "@kampus/tuval-ui/testing/inspector";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {piSessionProgram} from "../pi/program.ts";
import {pageInspectors} from "./renderers.tsx";

const processId = ProcessId.make("p1");

describe("the reference both backend rows declare", () => {
	// The layer is a stub: these two cases read what the rows *declare*, and never run one.
	const scripted = ScriptedAiAgent.layer({
		sessionId: "inspector-test",
		history: [],
		modes: {current: null, available: []},
		models: {current: null, available: []},
		thinking: {current: null, available: []},
		interrupt: [],
		turns: [],
	});
	const claudeRow = claudeSession({cwd: CWD, layer: scripted});
	const piRow = piSessionProgram({cwd: CWD, layer: scripted});

	it("is the same one, because every value in the panel is generic session state", () => {
		expect(claudeRow.inspector).toBeDefined();
		expect(claudeRow.inspector).toEqual(piRow.inspector);
	});

	it.each([
		["claude-session", claudeRow],
		["pi-session", piRow],
	])("resolves to the page's inspector renderer for %s", async (_name, row) => {
		const programId = ProgramId.make(row.id);
		const process = await Effect.runPromise(
			testProcess<AiAgentSessionState, AiAgentSessionMsg>(processId, agentSessionState()),
		);
		const host = await Effect.runPromise(process.window(WindowId.make("w0"), {selected: null}));
		const region = inspectorFor(
			deskSnapshot({
				focused: {windowId: WindowId.make("w0"), processId, host: host as AnyWindowHost},
				processes: {[processId]: {programId}},
				programs: {[programId]: row},
				inspectors: pageInspectors,
			}),
		);
		expect(region._tag).toBe("Inspector");
		if (region._tag !== "Inspector") return;
		expect(region.renderer).toBe(AiAgentInspector);
	});
});
