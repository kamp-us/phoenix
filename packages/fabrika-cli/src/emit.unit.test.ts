/**
 * The coverage guard: a group that writes its own `emit` opts out of the drain and truncates its
 * answers again, silently and on exit 0 (#6226). Reds instead.
 *
 * It reads source text rather than behaviour on purpose — the defect is invisible in-process, so
 * only a spawn can observe it (`./emit.cli.test.ts` does, once), and spawning all 29 groups to prove
 * a shared helper is still shared is not a budget this package has.
 */
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

const groupCommands = readdirSync(SRC, {withFileTypes: true})
	.filter((entry) => entry.isDirectory())
	.map((entry) => [`${entry.name}/command.ts`, `${SRC}${entry.name}/command.ts`] as const)
	.filter(([, path]) => {
		try {
			readFileSync(path, "utf8");
			return true;
		} catch {
			return false;
		}
	});

describe("every verb group emits through the shared, drain-safe helper", () => {
	it("finds group adapters at all — fail closed on zero scope (ADR 0092)", () => {
		expect(groupCommands.length).toBeGreaterThan(0);
	});

	it.each(groupCommands)("`%s` imports it rather than declaring one", (_label, path) => {
		expect(readFileSync(path, "utf8")).toContain('from "../emit.ts"');
	});

	it.each(groupCommands)("`%s` never exits on an undrained write", (_label, path) => {
		expect(readFileSync(path, "utf8")).not.toContain("process.exit(outcome.code)");
	});
});
