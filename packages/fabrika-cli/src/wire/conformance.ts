/**
 * The conformance laws, applied to every registered format by iterating the registry.
 *
 * The totality law is worth exactly as much as the diligence of whoever lands the next format, and
 * per-format tests are diligence. So the laws live here, over `WireFormat` and nothing narrower —
 * this module never learns a format's name, never branches on one, and holds no skip list. A row is
 * checked because it is in the array, and the samples the laws are driven from ride on the row
 * itself (`WireFixtures`), which the type makes required: a row added without them does not compile,
 * so coverage cannot quietly shrink to the formats whose author remembered to write tests.
 *
 * The compile-time half of the same idea is `format.ts`'s `brandWitness`, whose signature collapses
 * to `never` when a brand is weakened to `string`. The two halves are complementary: what a type can
 * refuse it refuses here at build time, and what it cannot — that `read` answers `Malformed` rather
 * than `Absent` for a drift — the findings below refuse at test time.
 *
 * Zero scope is a refusal, not a pass (ADR 0092): a suite that iterated an empty registry would run
 * no assertions and report green, which is the vacuous pass the law exists to forbid.
 */
import type {WireFormat, WireReadLines} from "./format.ts";

/** One broken law, named against the row that broke it. */
export interface ConformanceFinding {
	readonly format: string;
	readonly law: string;
	readonly detail: string;
}

export type ConformanceReport =
	| {readonly _tag: "ZeroScope"; readonly scanned: 0; readonly reason: string}
	| {
			readonly _tag: "Scanned";
			readonly scanned: number;
			readonly findings: ReadonlyArray<ConformanceFinding>;
	  };

/** The law names, so a finding and this module's prose cannot drift apart. */
export const LAWS = {
	emits: "emit composes the round-trip fixture",
	roundTrip: "read(emit(fields)) is Found",
	recovers: "the Found answer carries every field value it was given",
	emptyIsAbsent: "empty bytes read Absent — never Found",
	absentIsAbsent: "the declared absent fixture reads Absent — never Found, never Malformed",
	driftIsMalformed: "each declared drift fixture reads Malformed — never Found, never Absent",
	brandsNamed: "the row's brand witnesses name distinct, non-blank fields",
	keysUnique: "each registered key appears once",
} as const;

const answerOf = (read: WireReadLines): string =>
	read._tag === "Found" ? read.value.join("\n") : "";

export const conformFormat = (format: WireFormat): ReadonlyArray<ConformanceFinding> => {
	const findings: ConformanceFinding[] = [];
	const fail = (law: string, detail: string): void => {
		findings.push({format: format.key, law, detail});
	};

	const {roundTrip, absent, malformed} = format.fixtures;
	const composed = format.emit(roundTrip.fields);
	if (composed._tag !== "Composed") {
		fail(LAWS.emits, `emit answered Unusable: ${composed.reason}`);
	} else {
		const read = format.read(composed.bytes);
		if (read._tag !== "Found") {
			fail(LAWS.roundTrip, `its own emitted bytes read back ${read._tag}: ${read.reason}`);
		} else {
			const answer = answerOf(read);
			const dropped = roundTrip.values.filter((value) => !answer.includes(value));
			if (dropped.length > 0) {
				fail(LAWS.recovers, `the answer dropped ${dropped.map((v) => `"${v}"`).join(", ")}`);
			}
		}
	}

	const empty = format.read("");
	if (empty._tag !== "Absent") {
		fail(LAWS.emptyIsAbsent, `empty bytes read ${empty._tag}`);
	}

	const declaredAbsent = format.read(absent);
	if (declaredAbsent._tag !== "Absent") {
		fail(LAWS.absentIsAbsent, `the absent fixture read ${declaredAbsent._tag}`);
	}

	for (const fixture of malformed) {
		const drifted = format.read(fixture.artifact);
		if (drifted._tag !== "Malformed") {
			fail(LAWS.driftIsMalformed, `"${fixture.drift}" read ${drifted._tag}`);
		}
	}

	const fields = format.brands.map((witness) => witness.field.trim());
	if (fields.some((field) => field === "")) {
		fail(LAWS.brandsNamed, "a brand witness names no field");
	}
	if (new Set(fields).size !== fields.length) {
		fail(LAWS.brandsNamed, `the same field is witnessed twice: ${fields.join(", ")}`);
	}

	return findings;
};

export const conformRegistry = (formats: ReadonlyArray<WireFormat>): ConformanceReport => {
	if (formats.length === 0) {
		return {
			_tag: "ZeroScope",
			scanned: 0,
			reason:
				"wire conformance scanned 0 formats — an empty registry proves nothing about the totality law (ADR 0092)",
		};
	}

	const findings = formats.flatMap(conformFormat);
	const keys = formats.map((format) => format.key);
	const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
	const keyFindings: ReadonlyArray<ConformanceFinding> = [...new Set(duplicates)].map((key) => ({
		format: key,
		law: LAWS.keysUnique,
		detail: `"${key}" is registered more than once — which row --format resolves to is undecidable`,
	}));

	return {_tag: "Scanned", scanned: formats.length, findings: [...findings, ...keyFindings]};
};

/** One line per finding, for an assertion message a reader can act on without opening the row. */
export const describeFindings = (findings: ReadonlyArray<ConformanceFinding>): string =>
	findings.map(({format, law, detail}) => `${format}: ${law} — ${detail}`).join("\n");
