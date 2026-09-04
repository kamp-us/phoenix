/**
 * The two boundaries this layer keeps: no Pi type reaches its public surface, and the per-launch
 * token reaches nothing at all.
 *
 * The surface probe states its expected answer on the right of an `=`, with a positive control
 * pinned to the opposite value, per `.patterns/unconditional-test-assertions.md`'s type-level
 * sibling section — a probe that compiles either way proves nothing, so both lines were flipped
 * and confirmed to red with `TS2322` before this file landed.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Layer} from "effect";
import {describe, expect, it} from "vitest";
import type {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import type {PiServerService, PiSessionHost, ServerBindFailed} from "../server/index.ts";
import {PiAiAgent} from "./index.ts";

type AgentOnly<L> =
	L extends Layer.Layer<infer A, infer E, infer R>
		? [A, E, R] extends [TuvalAiAgent, ServerBindFailed, PiSessionHost]
			? true
			: false
		: false;

const surface: AgentOnly<ReturnType<typeof PiAiAgent.layer>> = true;

/** The control: a layer that published the server would publish the token with it. */
const leaksTheServer: AgentOnly<
	Layer.Layer<TuvalAiAgent | PiServerService, ServerBindFailed, PiSessionHost>
> = false;

describe("the Pi AI agent layer's surface", () => {
	it("provides the interface and nothing else", () => {
		expect([surface, leaksTheServer]).toEqual([true, false]);
	});

	it("publishes only the layer and its own options", () => {
		expect(Object.keys(PiAiAgent).sort()).toEqual(["layer", "layerOver"]);
	});

	it("re-exports no Pi type through its entry point", () => {
		const entry = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
		expect(entry).not.toMatch(/@earendil-works/);
	});
});

describe("the per-launch token", () => {
	it("is named by no source under this module", () => {
		const named = sources().flatMap(({name, text}) =>
			stripComments(text)
				.split("\n")
				.filter((line) => /\btoken\b/i.test(line))
				.map((line) => `${name}: ${line.trim()}`),
		);
		expect(named).toEqual([]);
	});
});

const sources = (): ReadonlyArray<{name: string; text: string}> => {
	const dir = import.meta.dirname;
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts") && !name.includes(".test."))
		.map((name) => ({name, text: readFileSync(join(dir, name), "utf8")}));
};

const stripComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
