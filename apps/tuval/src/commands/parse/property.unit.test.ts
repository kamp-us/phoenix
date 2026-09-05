/**
 * The two properties the palette rests on, over generated registries and generated lines.
 *
 * The generator is a seeded LCG in this file rather than `fast-check`, so the corpus is fixed: a
 * failure names one seed and one case, and adding a property costs no dependency in a package whose
 * Effect pin already sits on its own catalog. Every prefix of every generated line is checked, which
 * is the whole space for that line rather than a sample of it.
 *
 * Arguments are written in all four spellings a config author can use — bare, quoted, backslash
 * escaped, and `name=value` — because those are the four places `tokenize.ts` and `reading.ts`
 * hand-roll, and a corpus of bare lowercase words never reaches any of them.
 */

import {describe, expect, it} from "vitest";
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

/**
 * Values that only survive the round trip if the lexer's quoting and escaping work: a separator
 * inside a value, a quote, a backslash, and an `=` that must not be read as a parameter name —
 * `a` is not a parameter of any generated spell, so `a=b` is one positional value and not a
 * binding.
 */
const AWKWARD = ["ax 1", 'say "hi"', "c:\\tmp", "a=b", "two  spaces"];

/** A value the lexer reads back unchanged with no quoting and no escaping. */
const BARE = /^[A-Za-z0-9_-]+$/;

const quoted = (value: string): string => `"${value.replace(/[\\"]/g, (mark) => `\\${mark}`)}"`;

const escaped = (value: string): string => value.replace(/[\\"\s]/g, (mark) => `\\${mark}`);

/**
 * How one argument is written on the line. `named` is the only spelling that changes where the
 * value binds; the other three are four ways of writing the same token text.
 */
type Spelling = "bare" | "quoted" | "escaped" | "named";

const write = (value: string, spelling: Spelling, name: string): string => {
	if (spelling === "bare") return BARE.test(value) ? value : quoted(value);
	if (spelling === "quoted") return quoted(value);
	if (spelling === "escaped") return escaped(value);
	return `${name}=${BARE.test(value) ? value : quoted(value)}`;
};

/** One generated line: the text, and the call the parser owes for it. */
interface Case {
	readonly line: string;
	readonly path: ReadonlyArray<string>;
	readonly args: Readonly<Record<string, string>>;
}

interface Generated {
	readonly registry: SpellIndex;
	readonly cases: ReadonlyArray<Case>;
}

const generate = (seed: number): Generated => {
	const next = seeded(seed);
	const descriptions: Array<RegistryDescription[number]> = [];
	const cases: Array<Case> = [];
	const taken = new Set<string>();

	for (let index = 0; index < 12; index += 1) {
		const depth = 1 + next(3);
		const path = Array.from({length: depth}, () => SEGMENTS[next(SEGMENTS.length)]!);
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

		const args: Record<string, string> = {};
		const written = names.map((name, position) => {
			// An enum parameter refuses anything outside its literals, so its value is always one of
			// them; only how it is written varies. `named` is left to the free parameters, whose
			// value is unconstrained and so cannot turn a truncated prefix into a refusal.
			const isEnum = position === enumAt;
			const value = isEnum
				? LITERALS[next(LITERALS.length)]!
				: next(2) === 0
					? VALUES[next(VALUES.length)]!
					: AWKWARD[next(AWKWARD.length)]!;
			const spelling: Spelling = isEnum
				? (["bare", "quoted", "escaped"] as const)[next(3)]!
				: (["bare", "quoted", "escaped", "named"] as const)[next(4)]!;
			args[name] = value;
			return write(value, spelling, name);
		});
		cases.push({line: [...path, ...written].join(" "), path, args});
	}

	return {registry: buildSpellIndex(descriptions), cases};
};

const corpus = (seeds: number): ReadonlyArray<Generated> =>
	Array.from({length: seeds}, (_, index) => generate(index + 1));

describe("the generated corpus", () => {
	it("reaches the syntax the lexer and the reader hand-roll", () => {
		const lines = corpus(40).flatMap((generated) => generated.cases.map((one) => one.line));
		const values = corpus(40).flatMap((generated) =>
			generated.cases.flatMap((one) => Object.values(one.args)),
		);

		expect(
			lines.some((line) => line.includes('"')),
			"no line carries a quote",
		).toBe(true);
		expect(
			lines.some((line) => line.includes("\\")),
			"no line carries a backslash",
		).toBe(true);
		expect(
			lines.some((line) => line.includes("=")),
			"no line carries an =",
		).toBe(true);
		expect(
			lines.some((line) => / (?:workspace|second)=/.test(line)),
			"no line binds an argument by name",
		).toBe(true);
		// A line can carry a quote without any value needing one, so the values are checked too: a
		// corpus whose quotes are all decoration proves nothing about the unquoting.
		expect(
			values.some((value) => / /.test(value)),
			"no value carries a separator",
		).toBe(true);
		expect(
			values.some((value) => value.includes('"')),
			"no value carries a quote",
		).toBe(true);
		expect(
			values.some((value) => value.includes("\\")),
			"no value carries a backslash",
		).toBe(true);
		expect(
			values.some((value) => value.includes("=")),
			"no value carries an =",
		).toBe(true);
	});
});

describe("every prefix of a complete line is Partial or Complete", () => {
	it("never refuses and never throws, over 40 generated registries", () => {
		const offenders: Array<string> = [];
		for (let seed = 1; seed <= 40; seed += 1) {
			const {registry, cases} = generate(seed);
			for (const {line, path, args} of cases) {
				// The line itself must parse, and to the call it was written for: a quoted or escaped
				// value read back as its raw text is a Complete line carrying the wrong arguments.
				const whole = parse(line, registry, snapshot);
				expect(whole._tag, `seed ${seed}: ${line}`).toBe("Complete");
				if (whole._tag === "Complete") {
					expect(whole.call, `seed ${seed}: ${line}`).toEqual({path, args});
				}
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
			const {registry, cases} = generate(seed);
			for (const {line} of cases) {
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
