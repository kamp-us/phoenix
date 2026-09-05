/**
 * The attach path, checked against the shell rather than asserted. `./attach.ts` spells the address
 * out as a literal so the page bundle does not pull the kernel-side shell row in behind it, and this
 * test is what keeps that literal honest: it reads the shell's own spell list and its program id,
 * and fails the moment `window:attach` is renamed, re-pathed or given a second parameter.
 */

import {describe, expect, it} from "vitest";
import {renderPath} from "../../commands/spell.ts";
import {shellSpells} from "../../shell/commands/spells.ts";
import {shellId} from "../../shell/program.ts";
import {ATTACH_SPELL_PATH, attachArgs, callAttach, type SpellCaller} from "./attach.ts";
import {processId} from "./fixtures.ts";

const recorder = (): SpellCaller & {readonly calls: Array<{path: unknown; args: unknown}>} => {
	const calls: Array<{path: unknown; args: unknown}> = [];
	return {calls, call: (path, args) => void calls.push({path, args})};
};

describe("ATTACH_SPELL_PATH", () => {
	it("names a spell the shell actually publishes, at the address the registry keys it under", () => {
		const published = shellSpells.map((spell) => renderPath([shellId, ...spell.path]));
		expect(published).toContain(renderPath(ATTACH_SPELL_PATH));
	});

	it("carries the one parameter that spell declares", () => {
		const attach = shellSpells.find(
			(spell) => renderPath([shellId, ...spell.path]) === renderPath(ATTACH_SPELL_PATH),
		);
		expect(Object.keys(attach?.params.fields ?? {})).toEqual(["process"]);
	});
});

describe("callAttach", () => {
	it("issues one call, with that process id and nothing else", () => {
		const caller = recorder();
		callAttach(caller, processId("child-a1"));
		expect(caller.calls).toEqual([
			{path: ["shell", "window", "attach"], args: {process: "child-a1"}},
		]);
	});

	it("puts the process id in the parameter the spell names", () => {
		expect(attachArgs(processId("root-b"))).toEqual({process: "root-b"});
	});
});
