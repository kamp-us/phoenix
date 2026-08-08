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
import {brandWitness, type WireFormat, type WireReadLines} from "./format.ts";
import {registeredFormats} from "./registry.ts";

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
type ToyValue = string & {readonly [TOY]: true};

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
	producers: ["nobody"],
	consumers: ["nobody"],
	emit: (fields) => ({_tag: "Composed", bytes: `toy: ${fields.trim()}\n`}),
	read: toyRead,
	fixtures: {
		roundTrip: {fields: "alpha", values: ["alpha"]},
		absent: "prose that reaches for nothing\n",
		malformed: [{drift: "the key drifted", artifact: "toyish: alpha\n"}],
	},
	brands: [brandWitness<ToyValue>("value")],
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

	it("catches a padded brand declaration", () => {
		const format = broken({brands: [{field: "value"}, {field: "value"}]});
		expect(lawsBrokenBy(format)).toContain(LAWS.brandsNamed);
	});

	it("catches two rows registered under one key", () => {
		const report = conformRegistry([TOY_FORMAT, broken({purpose: "the shadowing row"})]);
		expect(report._tag).toBe("Scanned");
		if (report._tag !== "Scanned") return;
		expect(report.findings.map((finding) => finding.law)).toContain(LAWS.keysUnique);
	});
});

describe("brand weakening is caught at compile time, not here", () => {
	it("declares a brand witness for every registered format", () => {
		for (const format of registeredFormats) {
			expect(format.brands.length, `${format.key} declares no brand`).toBeGreaterThan(0);
		}
	});

	it("refuses a witness for a field typed as bare string", () => {
		// @ts-expect-error — `string extends string`, so the parameter collapses to `never`. This is
		// the counterexample every brand inherits by being declared on a row (`format.ts`).
		const weakened = brandWitness<string>("clause");
		expect(weakened.field).toBe("clause");
	});
});
