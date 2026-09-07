/**
 * The three boundaries the service surface keeps: every method's exact type is pinned, so no
 * `Promise` and no backend wire type can appear on it without reddening this file; the sources
 * name no backend; and no layer under here holds a retry loop.
 *
 * The pins are exact rather than "assignable to" on purpose — an assignability check passes a
 * signature that grew a Promise-typed field, which is the whole thing being refused.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Effect, Stream} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {AgentEvent} from "../events.ts";
import type {
	CommandRef,
	Mode,
	ModelRef,
	PermissionDecision,
	ThinkingLevel,
} from "../ports/index.ts";
import type {
	ListError,
	ModelUnsupported,
	ModeUnsupported,
	PageError,
	PromptError,
	StartError,
	ThinkingUnsupported,
	TransportError,
	UnknownRequest,
} from "./errors.ts";
import type {SessionSummary} from "./sessions.ts";
import type {
	StartedSession,
	StartOptions,
	TranscriptPage,
	TuvalAiAgentApi,
} from "./TuvalAiAgent.ts";

/**
 * The founder's seven grew to eight on #7981, to nine on #8060, to ten on #8062 and to eleven on
 * #8097. The first three are one act: he wants the agent's model, its slash commands and its
 * thinking level reachable from the chat composer, and a picker over a generic window has to reach
 * them through the generic interface — so `setModel`, `commands` and `setThinkingLevel` are those
 * three members. #8097's eleventh is the other: every session on his machine listed from one
 * program whatever backend started it, which is `listSessions`. Both pins below count eleven, so
 * each growth reads as the deliberate act it was rather than as drift.
 */
describe("the TuvalAiAgent surface", () => {
	it("carries the seven, #7981's, #8060's, #8062's and #8097's, at their declared types", () => {
		expectTypeOf<TuvalAiAgentApi["start"]>().toEqualTypeOf<
			(options: StartOptions) => Effect.Effect<StartedSession, StartError>
		>();
		expectTypeOf<TuvalAiAgentApi["prompt"]>().toEqualTypeOf<
			(text: string, key?: string) => Effect.Effect<void, PromptError>
		>();
		expectTypeOf<TuvalAiAgentApi["interrupt"]>().toEqualTypeOf<Effect.Effect<void>>();
		expectTypeOf<TuvalAiAgentApi["answer"]>().toEqualTypeOf<
			(request: string, decision: PermissionDecision) => Effect.Effect<void, UnknownRequest>
		>();
		expectTypeOf<TuvalAiAgentApi["setMode"]>().toEqualTypeOf<
			(mode: Mode) => Effect.Effect<void, ModeUnsupported>
		>();
		expectTypeOf<TuvalAiAgentApi["setModel"]>().toEqualTypeOf<
			(model: ModelRef) => Effect.Effect<void, ModelUnsupported>
		>();
		expectTypeOf<TuvalAiAgentApi["commands"]>().toEqualTypeOf<
			Effect.Effect<ReadonlyArray<CommandRef>>
		>();
		expectTypeOf<TuvalAiAgentApi["setThinkingLevel"]>().toEqualTypeOf<
			(level: ThinkingLevel) => Effect.Effect<void, ThinkingUnsupported>
		>();
		expectTypeOf<TuvalAiAgentApi["page"]>().toEqualTypeOf<
			(before: string | null, limit: number) => Effect.Effect<TranscriptPage, PageError>
		>();
		expectTypeOf<TuvalAiAgentApi["listSessions"]>().toEqualTypeOf<
			Effect.Effect<ReadonlyArray<SessionSummary>, ListError>
		>();
		expectTypeOf<TuvalAiAgentApi["events"]>().toEqualTypeOf<
			Stream.Stream<AgentEvent, TransportError>
		>();
	});

	it("has exactly those eleven members and no twelfth", () => {
		expectTypeOf<keyof TuvalAiAgentApi>().toEqualTypeOf<
			| "start"
			| "prompt"
			| "interrupt"
			| "answer"
			| "setMode"
			| "setModel"
			| "commands"
			| "setThinkingLevel"
			| "page"
			| "listSessions"
			| "events"
		>();
	});

	/**
	 * The listing's own boundary. `SDKSessionInfo` and pi's `SessionInfo` disagree on field names,
	 * on optionality and on whether a time is a `Date`, so an exact pin here is what refuses either
	 * of them reaching the port. The same pin holds the five absent-able fields absent-able, which
	 * is the no-plausible-zero rule the row depends on.
	 */
	it("returns a summary that names no backend and can leave five fields absent", () => {
		expectTypeOf<SessionSummary>().toEqualTypeOf<{
			readonly sessionId: string;
			readonly lastModified: number;
			readonly backend: string;
			readonly title?: string | undefined;
			readonly firstPrompt?: string | undefined;
			readonly folder?: string | undefined;
			readonly branch?: string | undefined;
			readonly messageCount?: number | undefined;
		}>();
	});
});

describe("the service module", () => {
	it("names no Promise anywhere in its sources", () => {
		expect(offenders(/\bPromise\b/)).toEqual([]);
	});

	it("holds no retry loop — retry policy is the handlers' declared data (#7371)", () => {
		expect(offenders(/\b(Effect\.retry|Effect\.repeat|Schedule\.|reconnect)\b/)).toEqual([]);
	});

	it("imports no backend — nothing from pi, claude or a model SDK", () => {
		const backends = /(^|\/)(pi|claude|shell)(\/|$)|@earendil-works|@anthropic-ai/;
		const found = sources().flatMap(({name, text}) =>
			[...text.matchAll(/from\s+"([^"]+)"/g)]
				.map((match) => match[1] ?? "")
				.filter((specifier) => backends.test(specifier))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(found).toEqual([]);
	});
});

const sources = (): ReadonlyArray<{name: string; text: string}> => {
	const dir = import.meta.dirname;
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"))
		.map((name) => ({name, text: readFileSync(join(dir, name), "utf8")}));
};

const stripComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const offenders = (banned: RegExp): ReadonlyArray<string> =>
	sources().flatMap(({name, text}) =>
		stripComments(text)
			.split("\n")
			.filter((line) => banned.test(line))
			.map((line) => `${name}: ${line.trim()}`),
	);
