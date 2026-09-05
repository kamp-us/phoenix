/**
 * The two boundaries this slice keeps: `KernelBridge`'s surface is Effect-native and SDK-free
 * (type-level, so `tsc` over this file is the proof), and no file that ships here names a program.
 * The second is what makes the tools generic: a tool that knows about one program is the special
 * case the kernel was meant to forbid.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Effect, Option} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {ProcessId} from "../../process/process.ts";
import type {ProgramId} from "../../registry/program.ts";
import type {PortRefused, UnknownPort, UnknownProcess, UnknownProgram} from "./errors.ts";
import type {KernelBridge} from "./KernelBridge.ts";

type Service = KernelBridge["Service"];

/** Every file this directory ships. The tests are excluded: a test must name a program to spawn one. */
const shipped = (): ReadonlyArray<{readonly name: string; readonly source: string}> => {
	const dir = import.meta.dirname;
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"))
		.map((name) => ({name, source: readFileSync(join(dir, name), "utf8")}));
};

describe("claude tools boundary", () => {
	it("KernelBridge's surface is Effects over kernel types, with no Promise and no SDK type", () => {
		expectTypeOf<keyof Service>().toEqualTypeOf<"spawn" | "send" | "read">();
		expectTypeOf<Service["spawn"]>().toEqualTypeOf<
			(program: ProgramId) => Effect.Effect<ProcessId, UnknownProgram>
		>();
		expectTypeOf<Service["send"]>().toEqualTypeOf<
			(
				process: ProcessId,
				port: string,
				payload: unknown,
			) => Effect.Effect<boolean, UnknownProcess | UnknownPort | PortRefused>
		>();
		expectTypeOf<Service["read"]>().toEqualTypeOf<
			(
				process: ProcessId,
				port: string,
			) => Effect.Effect<Option.Option<unknown>, UnknownProcess | UnknownPort>
		>();
		// Each return type is exactly an Effect, so no method can be answering with a Promise.
		expectTypeOf<ReturnType<Service["spawn"]>>().not.toMatchTypeOf<Promise<unknown>>();
		expectTypeOf<ReturnType<Service["send"]>>().not.toMatchTypeOf<Promise<unknown>>();
		expectTypeOf<ReturnType<Service["read"]>>().not.toMatchTypeOf<Promise<unknown>>();
	});

	it("the bridge module imports no SDK", () => {
		const bridge = shipped().find((file) => file.name === "KernelBridge.ts");
		expect(bridge).toBeDefined();
		const specifiers = [...(bridge?.source ?? "").matchAll(/from\s+"([^"]+)"/g)].map(
			(match) => match[1] ?? "",
		);
		const sdk = [/^@anthropic-ai\//, /^@modelcontextprotocol\//, /^zod$/];
		expect(specifiers.filter((one) => sdk.some((pattern) => pattern.test(one)))).toEqual([]);
	});

	it("nothing shipped from this directory names a program", () => {
		// A program id can only be minted from a literal, so a directory with no `ProgramId.make("…")`
		// and no id in its text is one no program can be written into.
		const offenders = shipped().flatMap(({name, source}) => {
			const found: string[] = [];
			if (/ProgramId\.make\(\s*"/.test(source)) found.push(`${name}: mints a program id`);
			for (const id of ["pi-session", "claude-session", "counter", "log", "echo"]) {
				if (source.includes(id)) found.push(`${name}: names "${id}"`);
			}
			for (const specifier of [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "")) {
				if (specifier.includes("/pi/")) found.push(`${name}: imports ${specifier}`);
			}
			return found;
		});
		expect(offenders).toEqual([]);
	});
});
