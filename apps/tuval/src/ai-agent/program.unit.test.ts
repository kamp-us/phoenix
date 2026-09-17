/**
 * The factory's inspector default (#9218): a row that says nothing about the desk inspector gets
 * the shared panel, because the absent case was the silent one — no type error, no failing test,
 * and an empty panel only a human toggling the desk would see (#9214).
 */

import {assert, describe, it} from "@effect/vitest";
import {aiAgentProgram} from "./program.ts";
import {AI_AGENT_INSPECTOR_REF} from "./renderer-ref.ts";
import {models, modes, thinking} from "./service/fixtures/scripts.ts";
import {type AgentScript, ScriptedAiAgent} from "./service/index.ts";

const script: AgentScript = {
	sessionId: "inspector-default-live",
	history: [],
	modes,
	models,
	thinking,
	turns: [],
	interrupt: [],
	sessions: [],
};

const row = (inspector?: {readonly kind: "host-native"; readonly ref: string}) =>
	aiAgentProgram({
		id: "inspector-default-session",
		layer: ScriptedAiAgent.layer(script),
		config: {cwd: "/workspace/phoenix"},
		...(inspector === undefined ? {} : {inspector}),
	});

describe("aiAgentProgram inspector", () => {
	it("defaults a row that declares none to the shared desk inspector", () => {
		assert.deepStrictEqual(row().inspector, AI_AGENT_INSPECTOR_REF);
	});

	it("keeps a row that wants a different panel on the one it named", () => {
		const own = {kind: "host-native", ref: "tuval/some-other-inspector"} as const;
		assert.deepStrictEqual(row(own).inspector, own);
	});
});
