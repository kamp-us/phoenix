/**
 * The two boundaries the core keeps.
 *
 * The first is structural and checked by the type checker: State, Msg, Cmd and Sub are plain data
 * all the way down, so a service, an Effect, a stream or a closure cannot appear on any of them
 * without reddening a probe here. Each probe puts its expected answer on the right of an `=`, and
 * the `notPlain` rows are the positive controls that prove the checker can say `false`
 * (`.patterns/unconditional-test-assertions.md`).
 *
 * The second is the import closure: nothing under this directory reaches `service/`, `handlers/`,
 * `pi/` or `claude/`, tests included. The failure-tag scan is the price of that closure — the core
 * writes the layer's tags as literals, so this reads `service/errors.ts` as text and reds when one
 * stops naming a tag that file declares.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Effect, Stream} from "effect";
import {describe, expect, it} from "vitest";
import type {AgentEvent} from "../events.ts";
import type {JsonValue} from "../ports/index.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg, AiAgentSessionSub} from "./messages.ts";
import type {AiAgentSessionState} from "./state.ts";

type Primitive = string | number | boolean | null | undefined;

/**
 * Recursive rather than an `extends PlainData` assignability check: TypeScript gives an interface
 * no implicit index signature, so every interface in the state tree would fail that check for a
 * reason that has nothing to do with the property being asserted.
 */
type IsPlainData<T> = T extends Primitive
	? true
	: // `JsonValue` is recursive, so it answers by assignability; walking into it with the mapped
		// recursion below is what TS calls an excessively deep instantiation.
		T extends JsonValue
		? true
		: T extends (...args: never[]) => unknown
			? false
			: T extends ReadonlyArray<infer Element>
				? IsPlainData<Element>
				: T extends object
					? {[K in keyof T]-?: IsPlainData<T[K]>}[keyof T] extends true
						? true
						: false
					: false;

const statePlain: IsPlainData<AiAgentSessionState> = true;
const msgPlain: IsPlainData<AiAgentSessionMsg> = true;
const cmdPlain: IsPlainData<AiAgentSessionCmd> = true;
const subPlain: IsPlainData<AiAgentSessionSub> = true;
const eventPlain: IsPlainData<AgentEvent> = true;

const effectNotPlain: IsPlainData<{readonly work: Effect.Effect<void>}> = false;
const streamNotPlain: IsPlainData<{readonly events: Stream.Stream<AgentEvent>}> = false;
const closureNotPlain: IsPlainData<{readonly dispose: () => void}> = false;
const socketNotPlain: IsPlainData<{readonly send: (frame: string) => void}> = false;

describe("the session's data surfaces", () => {
	it("carry no service, stream, Effect or closure at any depth", () => {
		expect([statePlain, msgPlain, cmdPlain, subPlain, eventPlain]).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
	});

	it("has probes that can say false — the controls", () => {
		expect([effectNotPlain, streamNotPlain, closureNotPlain, socketNotPlain]).toEqual([
			false,
			false,
			false,
			false,
		]);
	});
});

const sources = () =>
	readdirSync(import.meta.dirname)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => ({name, text: readFileSync(join(import.meta.dirname, name), "utf8")}));

const importsOf = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");

describe("the core's import closure", () => {
	it("reaches no layer, no handler and no backend", () => {
		const banned = /(^|\/)(service|handlers|pi|claude)(\/|$)|@earendil-works|@anthropic-ai/;
		const offenders = sources().flatMap(({name, text}) =>
			importsOf(text)
				.filter((specifier) => banned.test(specifier))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("reaches no sibling directory but events, ports, history and the fixtures", () => {
		const allowed = ["../events.ts", "../ports/", "../history/", "../../ai-agent-fixtures/"];
		const offenders = sources().flatMap(({name, text}) =>
			importsOf(text)
				.filter((specifier) => specifier.startsWith("."))
				.filter((specifier) => !specifier.startsWith("./"))
				.filter((specifier) => !allowed.some((prefix) => specifier.startsWith(prefix)))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("writes only failure tags the layer's errors declare", () => {
		const errors = readFileSync(join(import.meta.dirname, "..", "service", "errors.ts"), "utf8");
		const declared = new Set(
			[...errors.matchAll(/"(tuval\/ai-agent\/[A-Za-z]+)"/g)].map((match) => match[1]),
		);
		const failures = readFileSync(join(import.meta.dirname, "failures.ts"), "utf8");
		const written = [...failures.matchAll(/"(tuval\/ai-agent\/[A-Za-z]+)"/g)].map((m) => m[1]);
		expect(written.length).toBeGreaterThan(0);
		expect(written.filter((tag) => !declared.has(tag))).toEqual([]);
	});
});
