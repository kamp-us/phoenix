/**
 * The registry-level tier: the laws of `./conformance.ts`, run over whatever `./registry.ts` holds.
 *
 * Two halves, and the second is what makes the first worth anything. The first drives every
 * registered row through the laws without naming one. The second drives *deliberately broken*
 * synthetic rows through the same laws and asserts each one is caught — because a conformance suite
 * that cannot fail reports green over a registry that has stopped conforming, which is precisely the
 * plausible-negative failure the wire group exists to remove.
 */
import {describe, expect, it} from "vitest";
import {conformFormat, conformRegistry, describeFindings, LAWS} from "./conformance.ts";
import {type BrandedKeys, brandWitnesses, type WireFormat, type WireReadLines} from "./format.ts";
import {registeredFormats} from "./registry.ts";
import type * as verdictMarker from "./verdict-marker.ts";

describe("the registry conforms", () => {
	// `it.each` over an emptied registry would run zero assertions and report green, so scope is
	// asserted here, once, before any per-row case.
	it("scans every registered format and finds no broken law", () => {
		const report = conformRegistry(registeredFormats);
		expect(report._tag, `scanned ${report.scanned} formats`).toBe("Scanned");
		if (report._tag !== "Scanned") return;
		expect(report.scanned).toBe(registeredFormats.length);
		expect(describeFindings(report.findings)).toBe("");
	});

	it("reds on an empty registry, stating the count it scanned, rather than passing over nothing", () => {
		const report = conformRegistry([]);
		expect(report._tag).toBe("ZeroScope");
		if (report._tag !== "ZeroScope") return;
		expect(report.scanned).toBe(0);
		expect(report.reason).toContain("scanned 0 formats");
	});

	it.each(
		registeredFormats.map((format) => [format.key, format] as const),
	)("%s satisfies every law", (_key, format) => {
		expect(describeFindings(conformFormat(format))).toBe("");
	});
});

/**
 * A minimal conforming format, so the mutations below break exactly one law each.
 *
 * It is synthetic on purpose: mutating a real row would test that row's module, while the subject
 * here is the checker.
 */
declare const TOY: unique symbol;
type ToyText = string & {readonly [TOY]: true};

interface ToyValue {
	readonly value: ToyText;
	readonly checked: boolean;
}

const toyRead = (artifact: string): WireReadLines => {
	const line = artifact.trim();
	if (line === "") return {_tag: "Absent", reason: "nothing to judge"};
	if (line.startsWith("toy: ")) return {_tag: "Found", value: [`value\t${line.slice(5)}`]};
	if (line.startsWith("toy")) return {_tag: "Malformed", reason: "drifted", evidence: line};
	return {_tag: "Absent", reason: "no marker of this format"};
};

const TOY_FORMAT: WireFormat = {
	key: "toy",
	purpose: "a conforming format that exists only to be broken",
	module: "packages/fabrika-cli/src/wire/toy.ts",
	producers: ["nobody"],
	consumers: ["nobody"],
	emit: (fields) => ({_tag: "Composed", bytes: `toy: ${fields.trim()}\n`}),
	read: toyRead,
	fixtures: {
		roundTrip: {fields: "alpha", values: ["alpha"]},
		absent: "prose that reaches for nothing\n",
		malformed: [{drift: "the key drifted", artifact: "toyish: alpha\n"}],
	},
	brands: brandWitnesses<ToyValue>({value: true}),
};

const broken = (mutation: Partial<WireFormat>): WireFormat => ({...TOY_FORMAT, ...mutation});

const lawsBrokenBy = (format: WireFormat): ReadonlyArray<string> =>
	conformFormat(format).map((finding) => finding.law);

describe("the laws bite — each mutation is caught", () => {
	it("the baseline conforms, so every case below fails for its own reason", () => {
		expect(describeFindings(conformFormat(TOY_FORMAT))).toBe("");
	});

	it("catches an emit that cannot compose its own fixture", () => {
		const format = broken({emit: () => ({_tag: "Unusable", reason: "no fields"})});
		expect(lawsBrokenBy(format)).toContain(LAWS.emits);
	});

	it("catches a read that does not find its own emitted bytes", () => {
		const format = broken({read: () => ({_tag: "Absent", reason: "never finds anything"})});
		expect(lawsBrokenBy(format)).toContain(LAWS.roundTrip);
	});

	it("catches a read that finds the block but drops a field", () => {
		const format = broken({read: () => ({_tag: "Found", value: ["value\t"]})});
		expect(lawsBrokenBy(format)).toContain(LAWS.recovers);
	});

	it("catches empty bytes answered as Found — the plausible empty value itself", () => {
		const format = broken({
			read: (artifact) =>
				artifact.trim() === "" ? {_tag: "Found", value: ["value\t"]} : toyRead(artifact),
		});
		expect(lawsBrokenBy(format)).toContain(LAWS.emptyIsAbsent);
	});

	it("catches an absent artifact answered as Malformed", () => {
		const format = broken({
			read: (artifact) =>
				artifact.startsWith("prose")
					? {_tag: "Malformed", reason: "over-eager", evidence: artifact}
					: toyRead(artifact),
		});
		expect(lawsBrokenBy(format)).toContain(LAWS.absentIsAbsent);
	});

	it("catches a drift answered as Absent — the collapse this group exists to forbid", () => {
		const format = broken({
			read: (artifact) =>
				artifact.startsWith("toyish")
					? {_tag: "Absent", reason: "read it as nothing"}
					: toyRead(artifact),
		});
		expect(lawsBrokenBy(format)).toContain(LAWS.driftIsMalformed);
	});

	it("catches a drift answered as Found", () => {
		const format = broken({
			read: (artifact) =>
				artifact.startsWith("toyish")
					? {_tag: "Found", value: ["value\talpha"]}
					: toyRead(artifact),
		});
		expect(lawsBrokenBy(format)).toContain(LAWS.driftIsMalformed);
	});

	it("catches two rows registered under one key", () => {
		const report = conformRegistry([TOY_FORMAT, broken({purpose: "the shadowing row"})]);
		expect(report._tag).toBe("Scanned");
		if (report._tag !== "Scanned") return;
		expect(report.findings.map((finding) => finding.law)).toContain(LAWS.keysUnique);
	});
});

/**
 * The compile-time tier: the probes are `tsc`'s answers, pinned as values so they cannot pass
 * vacuously.
 *
 * `Inhabits` is written as an assignment rather than a `extends true` constraint on purpose: the
 * expected value sits on the right of an `=`, so flipping it reds with `TS2322` at the line that
 * states the claim. A probe that compiles either way proves nothing, which is exactly what the old
 * `brandWitness<A>` counterexample turned out to be — `A` was free, so it type-checked while naming
 * a brand the field did not carry (#4969).
 */
type Inhabits<K extends string, V> = K extends BrandedKeys<V> ? true : false;

/** `Clause` weakened to bare `string` — the counterexample, without touching the real module. */
interface WeakenedMarker {
	readonly namespace: string;
	readonly polarity: verdictMarker.Polarity;
	readonly sha: verdictMarker.HeadSha;
	readonly clause: string;
}

/**
 * A branded field keyed by a name that names nothing, alongside a real one.
 *
 * Written as a synthetic type rather than probed on `VerdictMarker`: that type has no blank key, so
 * a probe against it would answer `false` before and after the exclusion and bind nothing.
 */
interface BlankKeyed {
	readonly "": verdictMarker.HeadSha;
	readonly clause: verdictMarker.Clause;
}

/**
 * The same probe target for the whitespace `.trim()` strips beyond space/tab/LF/CR.
 *
 * These are the keys the exclusion missed while `Whitespace` was the four ASCII characters: each is
 * blank to the retired runtime law, so each has to be blank here too or the two disagree.
 */
interface WideBlankKeyed {
	readonly "\u00A0": verdictMarker.HeadSha;
	readonly "\u000B": verdictMarker.HeadSha;
	readonly "\u000C": verdictMarker.HeadSha;
	readonly "\uFEFF": verdictMarker.HeadSha;
	readonly "\u3000": verdictMarker.HeadSha;
	readonly clause: verdictMarker.Clause;
}

describe("the witness binds the field name to that field's own type", () => {
	it("admits a branded field, and only a branded field, of the value type", () => {
		// The positive control. If `BrandedKeys` collapsed to `never` every probe below would pass
		// for the wrong reason, and this line is what reds when it does.
		const branded: Inhabits<"clause", verdictMarker.VerdictMarker> = true;
		const bareString: Inhabits<"namespace", verdictMarker.VerdictMarker> = false;
		const notAField: Inhabits<"summary", verdictMarker.VerdictMarker> = false;

		expect([branded, bareString, notAField]).toEqual([true, false, false]);
	});

	it("drops a field whose brand was weakened to bare string", () => {
		const beforeWeakening: Inhabits<"clause", verdictMarker.VerdictMarker> = true;
		const afterWeakening: Inhabits<"clause", WeakenedMarker> = false;

		expect([beforeWeakening, afterWeakening]).toEqual([true, false]);
	});

	it("drops a key that names no field, so a blank witness is unwritable", () => {
		const blank: Inhabits<"", BlankKeyed> = false;
		// The positive control for this pair: without it a `BrandedKeys` collapsed to `never` would
		// satisfy the line above for the wrong reason.
		const nonBlank: Inhabits<"clause", BlankKeyed> = true;

		// @ts-expect-error — the counterexample itself: this compiled before the exclusion and yielded
		// a witness naming nothing. Every key is blank, so the parameter type is now `never`.
		brandWitnesses<{readonly "": verdictMarker.HeadSha}>({"": true});

		expect([blank, nonBlank]).toEqual([false, true]);
	});

	it("drops every key `trim()` calls blank, not just the four ASCII ones", () => {
		const nbsp: Inhabits<"\u00A0", WideBlankKeyed> = false;
		const verticalTab: Inhabits<"\u000B", WideBlankKeyed> = false;
		const formFeed: Inhabits<"\u000C", WideBlankKeyed> = false;
		const byteOrderMark: Inhabits<"\uFEFF", WideBlankKeyed> = false;
		const ideographicSpace: Inhabits<"\u3000", WideBlankKeyed> = false;
		// The positive control for this set, same role as the pair above.
		const nonBlank: Inhabits<"clause", WideBlankKeyed> = true;

		// @ts-expect-error — this compiled while `Whitespace` was the four ASCII characters, and the
		// witness it built named nothing. Every key is blank, so the parameter type is now `never`.
		brandWitnesses<{readonly "\u00A0": verdictMarker.HeadSha}>({"\u00A0": true});

		expect([nbsp, verticalTab, formFeed, byteOrderMark, ideographicSpace, nonBlank]).toEqual([
			false,
			false,
			false,
			false,
			false,
			true,
		]);
	});

	it("refuses the call shapes a row could otherwise get wrong", () => {
		const witnessed = brandWitnesses<verdictMarker.VerdictMarker>({
			sha: true,
			clause: true,
			polarity: true,
		});

		brandWitnesses<verdictMarker.VerdictMarker>({
			sha: true,
			clause: true,
			polarity: true,
			// @ts-expect-error — `namespace` is bare `string`, so it is not a branded key to witness.
			namespace: true,
		});
		// @ts-expect-error — a witness per branded field, not one per row: `clause` is missing.
		brandWitnesses<verdictMarker.VerdictMarker>({sha: true, polarity: true});
		// @ts-expect-error — weakened to bare `string`, `clause` is no longer a field this can witness.
		brandWitnesses<WeakenedMarker>({sha: true, clause: true, polarity: true});

		expect(witnessed.map((witness) => witness.field)).toEqual(["sha", "clause", "polarity"]);
	});

	it("refuses a value type with no branded field — zero scope is not an empty brands list", () => {
		// @ts-expect-error — the parameter type is `never`, so the call is unwritable (ADR 0092). The
		// runtime throw below is what a caller that reached it anyway gets: a refusal, never `[]`.
		expect(() => brandWitnesses<{readonly onlyBare: string}>({})).toThrow(/no branded field/);
	});

	it("declares a brand witness for every registered format", () => {
		for (const format of registeredFormats) {
			expect(format.brands.length, `${format.key} declares no brand`).toBeGreaterThan(0);
		}
	});
});
