/**
 * The rule the three discovery spells exist to keep: a spell's sentence is written once, at its own
 * `defineSpell` site, and every surface renders it from the registry (#7617 R2.4). So this greps the
 * sources under `src/commands/core/` for the two shapes a hand-written help table takes — another
 * spell's sentence copied in, and a pre-aligned help line baked into a literal.
 *
 * Test files are out of scope by design: a test that pins the rendered text is the pin, not a second
 * place the text is authored.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {table} from "./fixtures.ts";

const stripComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const sources = readdirSync(import.meta.dirname)
	.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
	.map((name) => ({
		name,
		text: readFileSync(join(import.meta.dirname, name), "utf8"),
	}));

const describes = async (): Promise<ReadonlyArray<string>> =>
	(await Effect.runPromise(table)).rows.map((row) => row.spell.describe);

describe("the core spell sources", () => {
	it("greps clean: no sentence is written in a file that does not define the spell", async () => {
		for (const sentence of await describes()) {
			const holders = sources.filter((source) => source.text.includes(sentence));
			expect(holders.map((source) => source.name).length).toBeLessThanOrEqual(1);
			for (const holder of holders) {
				// The one legal shape is the definition site itself.
				expect(holder.text).toContain(`describe: ${JSON.stringify(sentence)}`);
			}
		}
	});

	it("greps clean: no literal carries a pre-aligned help line", () => {
		for (const source of sources) {
			const literals = stripComments(source.text).match(/"(?:\\.|[^"\\\n])*"/g) ?? [];
			expect(literals.filter((literal) => /\s{2,}/.test(literal))).toEqual([]);
		}
	});

	it("reads the files it claims to read", () => {
		// Derived, not pinned: a sibling adding a spell file to core/ must not red this guard (#7642).
		const names = sources.map((source) => source.name);
		expect(names).toEqual(expect.arrayContaining(["help.ts", "spell.ts", "index.ts"]));
		expect(names.filter((name) => name.endsWith(".test.ts"))).toEqual([]);
		expect(names).toEqual([...names].sort());
	});
});
