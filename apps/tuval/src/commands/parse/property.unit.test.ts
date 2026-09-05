/**
 * The two properties the palette rests on, over generated registries and generated lines.
 *
 * The generator is a seeded LCG in this file rather than `fast-check`, so the corpus is fixed: a
 * failure names one seed and one case, and adding a property costs no dependency in a package whose
 * Effect pin already sits on its own catalog. Every prefix of every generated line is checked, which
 * is the whole space for that line rather than a sample of it.
 */

import {describe, expect, it} from "vitest";
import type {SpellPath} from "../../protocol/ids.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {complete} from "./complete.ts";
import {jsonSchema, snapshot} from "./fixtures.ts";
import {parse} from "./parse.ts";
import {buildSpellIndex, type SpellIndex} from "./spell-index.ts";

const seeded = (seed: number) => {
	let state = seed >>> 0;
	return (bound: number): number => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state % bound;
	};
};

// Segments and values are drawn from disjoint alphabets on purpose. A value equal to a sibling
// segment is a genuinely ambiguous line — `a b c` is both "spell a with two arguments" and "spell
// a.b with one" — and the documented rule resolves it to the longest path, so it is not a line the
// prefix property is about.
const SEGMENTS = ["window", "workspace", "process", "layout", "focus", "swap", "close", "open"];
const VALUES = ["ax-1", "ax-2", "zeta", "quux-3", "vv", "nought"];
const LITERALS = ["left", "right", "up", "down"];

interface Generated {
	readonly registry: SpellIndex;
	readonly lines: ReadonlyArray<string>;
}

const generate = (seed: number): Generated => {
	const next = seeded(seed);
	const descriptions: Array<RegistryDescription[number]> = [];
	const lines: Array<string> = [];
	const taken = new Set<string>();

	for (let index = 0; index < 12; index += 1) {
		const depth = 1 + next(3);
		const segment = () => SEGMENTS[next(SEGMENTS.length)]!;
		const path: SpellPath = [segment(), ...Array.from({length: depth - 1}, segment)];
		const key = path.join("\u0000");
		// A path that already carries a spell, or that runs through one, would re-address it.
		if (taken.has(key)) continue;
		taken.add(key);

		const arity = next(3);
		// The first name draws the snapshot's workspace set, so the determinism property covers the
		// fuzzy ranking and not only the prefix one.
		const names = ["workspace", "second"].slice(0, arity);
		const enumAt = arity === 0 ? -1 : next(arity + 1);
		const properties = Object.fromEntries(
			names.map((name, position) => [
				name,
				position === enumAt
					? ({type: "string", enum: LITERALS} as const)
					: ({type: "string"} as const),
			]),
		);
		descriptions.push({
			path,
			describe: `spell ${key}`,
			params: jsonSchema(properties, names),
			capabilities: [],
		});

		const args = names.map((_, position) =>
			position === enumAt ? LITERALS[next(LITERALS.length)]! : VALUES[next(VALUES.length)]!,
		);
		lines.push([...path, ...args].join(" "));
	}

	return {registry: buildSpellIndex(descriptions), lines};
};

describe("every prefix of a complete line is Partial or Complete", () => {
	it("never refuses and never throws, over 40 generated registries", () => {
		const offenders: Array<string> = [];
		for (let seed = 1; seed <= 40; seed += 1) {
			const {registry, lines} = generate(seed);
			for (const line of lines) {
				// The line itself must parse, or the case proves nothing about its prefixes.
				expect(parse(line, registry, snapshot)._tag, `seed ${seed}: ${line}`).toBe("Complete");
				for (let length = 0; length <= line.length; length += 1) {
					const prefix = line.slice(0, length);
					const result = parse(prefix, registry, snapshot);
					if (result._tag === "Refused") offenders.push(`seed ${seed}: "${prefix}" of "${line}"`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("ranking is deterministic", () => {
	it("returns an equal list for equal input and snapshot, over every generated prefix", () => {
		for (let seed = 1; seed <= 20; seed += 1) {
			const {registry, lines} = generate(seed);
			for (const line of lines) {
				for (let length = 0; length <= line.length; length += 1) {
					const prefix = line.slice(0, length);
					expect(complete(prefix, registry, snapshot)).toEqual(
						complete(prefix, registry, snapshot),
					);
				}
			}
		}
	});
});
