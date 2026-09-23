/**
 * The desk's picker over the `claude-session` row: declaring a renderer is what lists a row there,
 * and the picker is the desk's, so this case lives beside the desk rather than in
 * `@kampus/tuval-claude`, whose own tests cover the row's declarations.
 */

import {assert, describe, it} from "@effect/vitest";
import {CLAUDE_SESSION_PROGRAM, claudeSession} from "@kampus/tuval-claude";
import {ScriptedAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {programEntries, showsInAWindow} from "../shell/picker/entries.ts";

const script = {
	sessionId: "claude-picker-test",
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
	thinking: {current: null, available: []},
	interrupt: [],
	turns: [],
};

describe("the claude-session program row", () => {
	it("shows in the picker, which is what declaring a renderer buys the row", () => {
		const declared = claudeSession({
			cwd: "/tmp/tuval-claude-picker",
			layer: ScriptedAiAgent.layer(script),
		});
		assert.isTrue(showsInAWindow(declared));
		assert.deepStrictEqual(
			programEntries([declared]).map((entry) => entry.programId),
			[ProgramId.make(CLAUDE_SESSION_PROGRAM)],
			"a row the picker leaves out is a program nobody can open a window on",
		);
	});
});
