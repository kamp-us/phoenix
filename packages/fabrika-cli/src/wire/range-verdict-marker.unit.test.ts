/**
 * The range-scoped marker's own tier: `emit`, the three answers `read` may give, and the two-format
 * boundary.
 *
 * The assertions that carry the design are the ones about the **mandatory** content field and about
 * what each reader does with the other's bytes. A range marker whose digest went missing binds
 * nothing — the SHAs it names do not survive the merge it exists to survive — so it must read
 * `Malformed` rather than as a weaker verdict, and a head-bound marker must not read as a range one.
 */
import {describe, expect, it} from "vitest";
import {clause, contentDigest, headSha} from "./marker-line.ts";
import {
	emit,
	emitFromFields,
	parseFields,
	parseRange,
	type RangeVerdictMarker,
	read,
	readToLines,
	renderMarker,
} from "./range-verdict-marker.ts";
import {read as readHeadMarker} from "./verdict-marker.ts";

const sha = (raw: string) => {
	const value = headSha(raw);
	if (value === null) throw new Error(`fixture is not a revision: ${raw}`);
	return value;
};
const digest = (raw: string) => {
	const value = contentDigest(raw);
	if (value === null) throw new Error(`fixture is not a content digest: ${raw}`);
	return value;
};
const text = (raw: string) => {
	const value = clause(raw);
	if (value === null) throw new Error("fixture clause is blank");
	return value;
};

const BASE = "9f2c1ab7d4a2c6f1b8093a5c4d2e1f6a7b8c9d01";
const TIP = "03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d";
const CONTENT = "2f1a9c4e0b7d";

const MARKER: RangeVerdictMarker = {
	namespace: "review-child",
	polarity: "PASS",
	range: {base: sha(BASE), tip: sha(TIP)},
	content: digest(CONTENT),
	clause: text("every criterion met"),
};

const found = (artifact: string): RangeVerdictMarker => {
	const result = read(artifact);
	if (result._tag !== "Found") throw new Error(`expected Found, got ${result._tag}`);
	return result.value;
};

describe("emit", () => {
	it("composes the one recognizable first line", () => {
		expect(emit(MARKER)).toBe(
			`review-child: PASS range:${BASE}..${TIP} content:${CONTENT} — every criterion met\n`,
		);
	});

	it("round-trips: every field emitted is a field `read` recovers", () => {
		expect(found(emit(MARKER))).toEqual(MARKER);
	});
});

describe("read", () => {
	it("reads the marker off the first line of a comment that then explains itself", () => {
		const body = `${emit(MARKER)}\nThe range is the child's branch over the epic branch point.\n`;
		expect(found(body)).toEqual(MARKER);
	});

	it("reads a bolded marker, closer and all", () => {
		expect(found(`**review-child: PASS range:${BASE}..${TIP} content:${CONTENT} — done**`)).toEqual(
			{...MARKER, clause: text("done")},
		);
	});

	it("lowercases the revisions, so one commit has one spelling", () => {
		expect(
			found(`review-child: pass range:${BASE.toUpperCase()}..${TIP} content:${CONTENT} — done`)
				.range.base,
		).toBe(BASE);
	});

	it("is Absent — not Malformed — on a comment carrying no marker of this family", () => {
		expect(read("Thanks — this reads well to me, no notes.\n")._tag).toBe("Absent");
	});

	/** Each of these would be a plausible PASS to a lenient reader, which is why each is pinned. */
	const drifts = [
		[
			"no content digest at all — the range form's one refusal",
			`review-child: PASS range:${BASE}..${TIP} — done`,
		],
		[
			"a content digest that is not 12 hex",
			`review-child: PASS range:${BASE}..${TIP} content:2f1a — done`,
		],
		["a head-bound marker, read here", `review-child: PASS @ ${TIP} content:${CONTENT} — done`],
		["a range naming one revision", `review-child: PASS range:${TIP} content:${CONTENT} — done`],
		["a range with an empty side", `review-child: PASS range:..${TIP} content:${CONTENT} — done`],
		[
			"a three-dot range, which is not the marker's spelling",
			`review-child: PASS range:${BASE}...${TIP} content:${CONTENT} — done`,
		],
		[
			"a revision too short to name one commit",
			`review-child: PASS range:03135..${TIP} content:${CONTENT} — done`,
		],
		[
			"a polarity nobody defined",
			`review-child: APPROVED range:${BASE}..${TIP} content:${CONTENT} — done`,
		],
		[
			"a namespace that is not kebab-case",
			`review_child: PASS range:${BASE}..${TIP} content:${CONTENT} — done`,
		],
		["no trailing clause", `review-child: PASS range:${BASE}..${TIP} content:${CONTENT}`],
	] as const;

	for (const [name, line] of drifts) {
		it(`is Malformed on ${name}`, () => {
			const result = read(`${line}\n`);
			expect(result._tag).toBe("Malformed");
			if (result._tag === "Malformed") expect(result.reason).not.toBe("");
		});
	}
});

/**
 * The two formats partition the surface loudly. Either reader answering `Absent` over the other's
 * bytes is what would make a verdict posted on the wrong surface look like no verdict at all.
 */
describe("the boundary with the PR-scoped marker", () => {
	it("reads a range marker as Malformed over there, never as Absent", () => {
		expect(readHeadMarker(emit(MARKER))._tag).toBe("Malformed");
	});

	it("reads a head-bound marker as Malformed here, never as Absent", () => {
		expect(read(`review-code: PASS @ ${TIP} content:${CONTENT} — merge-ready\n`)._tag).toBe(
			"Malformed",
		);
	});
});

describe("parseRange", () => {
	it("refuses a three-dot spelling rather than reading a tip that opens with a dot", () => {
		expect(parseRange(`${BASE}...${TIP}`)).toBeNull();
	});

	it("takes the FIRST separator, so a trailing one cannot silently retarget the tip", () => {
		expect(parseRange(`${BASE}..${TIP}..${BASE}`)).toBeNull();
	});
});

describe("parseFields", () => {
	const FIELDS = `namespace: review-child\npolarity: PASS\nbase: ${BASE}\ntip: ${TIP}\ncontent: ${CONTENT}\nclause: every criterion met\n`;

	it("composes the marker `read` recovers, from fields in any order", () => {
		const parsed = parseFields(FIELDS.split("\n").reverse().join("\n"));
		expect(parsed._tag === "Fields" && parsed.marker).toEqual(MARKER);
	});

	it("refuses a missing content field — a range verdict may not omit its binding", () => {
		const parsed = parseFields(FIELDS.replace(`content: ${CONTENT}\n`, ""));
		expect(parsed._tag).toBe("Unusable");
		expect(parsed._tag === "Unusable" && parsed.reason).toContain("content");
	});

	it("refuses a field given twice rather than picking one", () => {
		expect(parseFields(`${FIELDS}tip: ${BASE}\n`)._tag).toBe("Unusable");
	});

	it("refuses an unknown field rather than dropping it", () => {
		expect(parseFields(`${FIELDS}sha: ${TIP}\n`)._tag).toBe("Unusable");
	});
});

describe("the registry adapters", () => {
	it("emit → read is a round-trip through the byte-level pair", () => {
		const composed = emitFromFields(
			`namespace: review-child\npolarity: FAIL\nbase: ${BASE}\ntip: ${TIP}\ncontent: ${CONTENT}\nclause: two criteria unmet\n`,
		);
		expect(composed._tag).toBe("Composed");
		if (composed._tag !== "Composed") return;
		expect(readToLines(composed.bytes)).toEqual({
			_tag: "Found",
			value: renderMarker({...MARKER, polarity: "FAIL", clause: text("two criteria unmet")}),
		});
	});
});
