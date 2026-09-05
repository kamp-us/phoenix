/**
 * The boundary the row keeps: what it hands `aiAgentProgram` is a closed `Layer<TuvalAiAgent>`, the
 * row it returns is the generic program type, and no file that builds the row names the Agent SDK.
 *
 * The type pins are exact rather than "assignable to". An assignability check passes a layer that
 * grew a second requirement and a row that grew a Claude-shaped state, which is the whole thing
 * being refused.
 */

import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import type {Layer} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {
	AiAgentSessionCmd,
	AiAgentSessionMsg,
	AiAgentSessionState,
	AiAgentSessionSub,
} from "../ai-agent/core/index.ts";
import type {AiAgentProgram} from "../ai-agent/program.ts";
import type {TuvalAiAgent} from "../ai-agent/service/index.ts";
import type {PortSchema, Program} from "../registry/program.ts";
import {claudeSession, claudeSessionLayer} from "./program.ts";

/**
 * The row's four private types, read back off the program type it actually returns. Reading them
 * this way rather than restating the row's shape is what makes the pins below falsifiable: a row
 * that grew a Claude-shaped state would answer with that state here.
 */
type RowOf<K extends 0 | 1 | 2 | 3> =
	AiAgentProgram extends Program<infer S, infer M, infer C, infer U, any, any, any>
		? [S, M, C, U][K]
		: never;

type RowState = RowOf<0>;
type RowMsg = RowOf<1>;
type RowCmd = RowOf<2>;
type RowSub = RowOf<3>;

const specifiersOf = (text: string): ReadonlyArray<string> =>
	[...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

const sourcesUnder = (dir: string): ReadonlyArray<{name: string; text: string}> =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourcesUnder(path);
		return entry.endsWith(".ts") ? [{name: path, text: readFileSync(path, "utf8")}] : [];
	});

describe("what the row hands the factory", () => {
	it("is a TuvalAiAgent layer with nothing left to provide", () => {
		expectTypeOf(claudeSessionLayer).returns.toEqualTypeOf<Layer.Layer<TuvalAiAgent>>();
	});
});

describe("the row's own type", () => {
	it("is the generic program type, so no SDK type is reachable through it", () => {
		expectTypeOf(claudeSession).returns.toEqualTypeOf<AiAgentProgram>();
	});

	it("carries the generic state, Msg, Cmd and Sub, which name nothing Claude-shaped", () => {
		expectTypeOf<RowState>().toEqualTypeOf<AiAgentSessionState>();
		expectTypeOf<RowMsg>().toEqualTypeOf<AiAgentSessionMsg>();
		expectTypeOf<RowCmd>().toEqualTypeOf<AiAgentSessionCmd>();
		expectTypeOf<RowSub>().toEqualTypeOf<AiAgentSessionSub>();
	});

	it("declares its ports as the registry's own schemas, which carry no Claude payload", () => {
		expectTypeOf<AiAgentProgram["ports"]>().toEqualTypeOf<Readonly<Record<string, PortSchema>>>();
	});
});

describe("the files that build the row", () => {
	const dir = import.meta.dirname;
	const files = [
		join(dir, "program.ts"),
		join(dir, "config.ts"),
		join(dir, "renderer-ref.ts"),
		...sourcesUnder(join(dir, "restore")).map(({name}) => name),
	];

	it("name no Agent SDK import", () => {
		const offenders = files.flatMap((name) =>
			specifiersOf(readFileSync(name, "utf8"))
				.filter((specifier) => specifier.startsWith("@anthropic-ai/"))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});
});
