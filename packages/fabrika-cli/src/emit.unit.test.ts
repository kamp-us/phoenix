/**
 * The coverage guard: a group that writes its own `emit` opts out of the drain and truncates its
 * answers again, silently and on exit 0 (#6226). Reds instead.
 *
 * It reads source text rather than behaviour on purpose — the defect is invisible in-process, so
 * only a spawn can observe it (`./emit.cli.test.ts` does, once), and spawning every group to prove
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

/** The name the adapter bound the shared helper to — several import it `as emitOutcome`. */
const localName = (source: string): string | undefined => {
	const match = /\bemit(?:\s+as\s+(\w+))?\s*(?:,[^}]*)?\}\s*from\s*"\.\.\/emit\.ts"/.exec(source);
	return match === null ? undefined : (match[1] ?? "emit");
};

describe("every verb group emits through the shared, drain-safe helper", () => {
	it("finds group adapters at all — fail closed on zero scope (ADR 0092)", () => {
		expect(groupCommands.length).toBeGreaterThan(0);
	});

	it.each(groupCommands)("`%s` imports it rather than declaring one", (_label, path) => {
		expect(readFileSync(path, "utf8")).toContain('from "../emit.ts"');
	});

	it.each(groupCommands)("`%s` calls it, not merely imports it", (_label, path) => {
		const source = readFileSync(path, "utf8");
		const bound = localName(source);
		expect(bound).toBeDefined();
		expect(source).toMatch(new RegExp(`yield\\*\\s*${bound}\\(`));
	});

	// Any exit from an adapter is a hand-rolled emit however it is spelled: the answer is on stdout
	// by then, and only the shared helper's write callbacks know it drained.
	it.each(groupCommands)("`%s` never exits the process itself", (_label, path) => {
		expect(readFileSync(path, "utf8")).not.toMatch(/process\.exit\(/);
	});
});
