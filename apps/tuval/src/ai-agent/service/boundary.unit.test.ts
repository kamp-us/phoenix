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
import type {Mode, PermissionDecision} from "../ports/index.ts";
import type {
	ModeUnsupported,
	PageError,
	PromptError,
	StartError,
	TransportError,
	UnknownRequest,
} from "./errors.ts";
import type {AgentEvent} from "./events.ts";
import type {
	StartedSession,
	StartOptions,
	TranscriptPage,
	TuvalAiAgentApi,
} from "./TuvalAiAgent.ts";

describe("the TuvalAiAgent surface", () => {
	it("carries the founder's seven members, each at its declared type", () => {
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
		expectTypeOf<TuvalAiAgentApi["page"]>().toEqualTypeOf<
			(before: string | null, limit: number) => Effect.Effect<TranscriptPage, PageError>
		>();
		expectTypeOf<TuvalAiAgentApi["events"]>().toEqualTypeOf<
			Stream.Stream<AgentEvent, TransportError>
		>();
	});

	it("has exactly those seven members and no eighth", () => {
		expectTypeOf<keyof TuvalAiAgentApi>().toEqualTypeOf<
			"start" | "prompt" | "interrupt" | "answer" | "setMode" | "page" | "events"
		>();
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
