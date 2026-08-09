/**
 * The schema module's own tier: `emit`, the three answers `read` may give, and the binding.
 *
 * The assertions that carry the design are the drift cases and the staleness cases. Each drift feeds
 * a line a lenient reader would answer "PASS" for — the SHA missing, the SHA truncated, the polarity
 * a word nobody defined — and asserts `Malformed`, because the failure this module removes is not a
 * crash, it is a *plausible* verdict. The binding cases assert the same thing one level up: a marker
 * bound to a head that moved is `Stale`, and a head that cannot be resolved is `Unbindable`, so
 * neither can be read as a current PASS.
 */
import {describe, expect, it} from "vitest";
import {
	bindToHead,
	clause,
	emit,
	emitFromFields,
	headSha,
	parseFields,
	read,
	readToLines,
	renderMarker,
	type VerdictMarker,
} from "./verdict-marker.ts";

const sha = (raw: string) => {
	const value = headSha(raw);
	if (value === null) throw new Error(`fixture is not a head SHA: ${raw}`);
	return value;
};
const text = (raw: string) => {
	const value = clause(raw);
	if (value === null) throw new Error("fixture clause is blank");
	return value;
};

const HEAD = "03135b91e7d4a2c6f1b8093a5c4d2e1f6a7b8c9d";

const MARKER: VerdictMarker = {
	namespace: "review-code",
	polarity: "PASS",
	sha: sha(HEAD),
	clause: text("merge-ready"),
};

const found = (artifact: string): VerdictMarker => {
	const result = read(artifact);
	if (result._tag !== "Found") throw new Error(`expected Found, got ${result._tag}`);
	return result.value;
};

const drift = (name: string, line: string) => ({name, line});

describe("emit", () => {
	it("composes the one recognizable first line", () => {
		expect(emit(MARKER)).toBe(`review-code: PASS @ ${HEAD} — merge-ready\n`);
	});

	it("round-trips: every field emitted is a field `read` recovers", () => {
		const markers: ReadonlyArray<VerdictMarker> = [
			MARKER,
			{
				namespace: "review",
				polarity: "FAIL",
				sha: sha("03135b9"),
				clause: text("changes-requested — 2 criteria unmet, see the table below"),
			},
		];
		for (const marker of markers) expect(found(emit(marker))).toEqual(marker);
	});
});

describe("read — Found", () => {
	it("recovers namespace, polarity, SHA and clause from a real verdict comment", () => {
		expect(
			found(`**review-code: FAIL @ ${HEAD} — not merge-ready**\n\n| criterion | verdict |\n`),
		).toEqual({
			namespace: "review-code",
			polarity: "FAIL",
			sha: sha(HEAD),
			clause: text("not merge-ready"),
		});
	});

	it("accepts a full 40-hex SHA and an abbreviated 7-hex SHA alike", () => {
		expect(found(`review: PASS @ ${HEAD} — ok`).sha).toBe(HEAD);
		expect(found("review: PASS @ 03135b9 — ok").sha).toBe("03135b9");
	});

	it("lowercases an upper-case SHA and an upper-case namespace rather than refusing them", () => {
		const marker = found("REVIEW-CODE: pass @ 03135B9 — ok");
		expect(marker.sha).toBe("03135b9");
		expect(marker.namespace).toBe("review-code");
		expect(marker.polarity).toBe("PASS");
	});
});

describe("read — Absent", () => {
	it("answers Absent for a comment that carries no marker of this format", () => {
		const result = read("Nice work — one nit on the naming, otherwise this reads well.\n");
		expect(result._tag).toBe("Absent");
	});

	it("answers Absent for a marker merely QUOTED further down, never Found", () => {
		const result = read(
			`The convention is:\n\n> review-code: PASS @ ${HEAD} — merge-ready\n\nnot what I posted.\n`,
		);
		expect(result._tag).toBe("Absent");
	});

	it("answers Absent for an empty artifact rather than inventing a malformed one", () => {
		expect(read("\n   \n")._tag).toBe("Absent");
	});
});

/**
 * The plan gate's namespace, widened additively (#5107).
 *
 * The pair below is the point: `read` gates on the namespace **prefix** before `NAMESPACE` is ever
 * tested, so widening only the regex leaves the format able to emit a marker it can never read back.
 * Revert either edit and the round-trip case reds while the `review` cases stay green — which is
 * exactly how the defect would have shipped.
 */
describe("read — the check-epic-plan namespace", () => {
	const DIGEST = "4d90e1bb27ac";

	it("round-trips a plan verdict through emit and read", () => {
		const text = clause("2 children scanned, floor clean");
		const sha = headSha(DIGEST);
		expect(text).not.toBeNull();
		expect(sha).not.toBeNull();
		if (text === null || sha === null) return;
		const result = read(emit({namespace: "check-epic-plan", polarity: "PASS", sha, clause: text}));
		expect(result._tag).toBe("Found");
		if (result._tag !== "Found") return;
		expect(result.value.namespace).toBe("check-epic-plan");
		expect(result.value.sha).toBe(DIGEST);
	});

	it("still answers Absent for a namespace that reaches for neither family", () => {
		expect(read(`checkout: PASS @ ${DIGEST} — done\n`)._tag).toBe("Absent");
	});

	it("leaves the review family's reading untouched", () => {
		expect(read(`review-code: PASS @ ${HEAD} — merge-ready\n`)._tag).toBe("Found");
		expect(read(`review_code: PASS @ ${HEAD} — merge-ready\n`)._tag).toBe("Malformed");
	});
});

/**
 * The governance namespace, widened additively (#5199).
 *
 * `ship scope` already derives `governance` as a required namespace, so a format that cannot carry
 * it leaves every governance-root PR permanently `blocked` at `ship gate` with no second door. The
 * cases below are the two halves of that claim: the namespace round-trips, and every reading this
 * format already gave is byte-for-byte unchanged — the widening may only *add* readable markers.
 */
describe("read — the governance namespace", () => {
	it("round-trips a governance verdict through emit and read", () => {
		const result = read(
			emit({namespace: "governance", polarity: "PASS", sha: sha(HEAD), clause: text("clean")}),
		);
		expect(result._tag).toBe("Found");
		if (result._tag !== "Found") return;
		expect(result.value.namespace).toBe("governance");
		expect(result.value.sha).toBe(HEAD);
	});

	it("reads a hand-written governance marker, the only door until `governance post` exists", () => {
		expect(read(`**governance: PASS @ ${HEAD} — corpus clean**\n`)._tag).toBe("Found");
	});

	it("leaves every namespace this format already read exactly as it read them", () => {
		for (const namespace of ["review", "review-code", "review-doc", "review-skill", "review-ui"]) {
			const parsed = read(`${namespace}: PASS @ ${HEAD} — merge-ready\n`);
			expect(parsed._tag).toBe("Found");
			expect(parsed._tag === "Found" ? parsed.value.namespace : "").toBe(namespace);
		}
		expect(read(`check-epic-plan: FAIL @ ${HEAD} — 1 defect\n`)._tag).toBe("Found");
		expect(read(`review_code: PASS @ ${HEAD} — merge-ready\n`)._tag).toBe("Malformed");
		expect(read(`reviewcode: PASS @ ${HEAD} — merge-ready\n`)._tag).toBe("Malformed");
		expect(read(`ship: PASS @ ${HEAD} — done\n`)._tag).toBe("Absent");
	});

	it("still answers Absent for a namespace that only rhymes with this one", () => {
		expect(read(`govern: PASS @ ${HEAD} — done\n`)._tag).toBe("Absent");
	});

	it("answers Malformed, never Found, for a governance namespace that drifted", () => {
		expect(read(`governance_corpus: PASS @ ${HEAD} — done\n`)._tag).toBe("Malformed");
	});
});

describe("read — Malformed: the drifts a lenient reader answers `PASS` for", () => {
	const DRIFTS = [
		drift("no SHA at all", "review-code: PASS — merge-ready"),
		drift("an @ with nothing after it", "review-code: PASS @ — merge-ready"),
		drift("a SHA one character under the floor", "review-code: PASS @ 03135b — merge-ready"),
		drift("a SHA carrying a non-hex character", "review-code: PASS @ 03135bz — merge-ready"),
		drift("a SHA longer than a git object name", `review-code: PASS @ ${HEAD}00 — merge-ready`),
		drift("a polarity nobody defined", `review-code: APPROVED @ ${HEAD} — merge-ready`),
		drift("a polarity that is only a near-miss", `review-code: PASSED @ ${HEAD} — merge-ready`),
		drift("no polarity at all", `review-code: @ ${HEAD} — merge-ready`),
		drift("a namespace that lost its hyphen", `reviewcode: PASS @ ${HEAD} — merge-ready`),
		drift("a namespace in snake_case", `review_code: PASS @ ${HEAD} — merge-ready`),
		drift("no trailing clause", `review-code: PASS @ ${HEAD}`),
		drift("a separator with no clause after it", `review-code: PASS @ ${HEAD} —`),
	];

	for (const {name, line} of DRIFTS) {
		it(`${name} is Malformed — never Found, never Absent`, () => {
			const result = read(`${line}\n`);
			expect(result._tag).toBe("Malformed");
			if (result._tag !== "Malformed") return;
			expect(result.evidence).toContain(line.trim());
			expect(result.reason).not.toBe("");
		});
	}

	it("names the missing SHA specifically, so a reviewer learns WHICH half drifted", () => {
		const result = read("review-code: PASS — merge-ready\n");
		if (result._tag !== "Malformed") throw new Error("expected Malformed");
		expect(result.reason).toContain("head SHA");
	});

	it("names the unrecognized polarity token specifically", () => {
		const result = read(`review-code: APPROVED @ ${HEAD} — merge-ready\n`);
		if (result._tag !== "Malformed") throw new Error("expected Malformed");
		expect(result.reason).toContain("APPROVED");
	});
});

describe("read — Absent and Malformed are two answers, not one collapsed negative", () => {
	it("keeps a body with no marker apart from a body whose marker drifted", () => {
		const noMarker = read("Looks good to me, shipping it.\n");
		const drifted = read("review-code: PASS — merge-ready\n");
		expect(noMarker._tag).toBe("Absent");
		expect(drifted._tag).toBe("Malformed");
		expect(noMarker._tag).not.toBe(drifted._tag);
	});

	it("never answers Found for either, so no caller reads a drift as an unreviewed PR", () => {
		for (const artifact of [
			"chatter with no marker",
			"review: PASS — no sha",
			"review: OK @ 03135b9 — x",
		]) {
			expect(read(artifact)._tag).not.toBe("Found");
		}
	});
});

describe("bindToHead — stale is its own outcome, never a PASS and never an absence", () => {
	it("answers Current when the marker's SHA is the head", () => {
		expect(bindToHead(MARKER, HEAD)).toEqual({_tag: "Current", sha: HEAD});
	});

	it("answers Current across an abbreviation, in either direction", () => {
		expect(bindToHead(MARKER, "03135b9")._tag).toBe("Current");
		expect(bindToHead({...MARKER, sha: sha("03135b9")}, HEAD)._tag).toBe("Current");
	});

	it("answers Stale for a head that moved under the verdict — the PASS does not survive it", () => {
		const binding = bindToHead(MARKER, "7d588903c1a2b3d4e5f60718293a4b5c6d7e8f90");
		expect(binding._tag).toBe("Stale");
		if (binding._tag !== "Stale") return;
		expect(binding.markerSha).toBe(HEAD);
	});

	it("answers Unbindable for a head it cannot resolve — a comparison it could not make is not a negative", () => {
		for (const head of ["", "HEAD", "not-a-sha", "03135b"]) {
			expect(bindToHead(MARKER, head)._tag).toBe("Unbindable");
		}
	});

	it("keeps Current, Stale and Unbindable pairwise distinct", () => {
		const tags = [
			bindToHead(MARKER, HEAD)._tag,
			bindToHead(MARKER, "7d588903")._tag,
			bindToHead(MARKER, "HEAD")._tag,
		];
		expect(new Set(tags).size).toBe(tags.length);
	});
});

describe("parseFields", () => {
	it("takes the four fields in any order, as `<key>: <value>` or `<key><TAB><value>`", () => {
		expect(
			parseFields(`clause: merge-ready\nsha\t${HEAD}\npolarity: PASS\nnamespace: review-code\n`),
		).toEqual({_tag: "Fields", marker: MARKER});
	});

	it("refuses a missing field rather than composing a weaker marker than the caller wrote", () => {
		const parsed = parseFields("namespace: review-code\npolarity: PASS\nclause: merge-ready\n");
		expect(parsed._tag).toBe("Unusable");
		if (parsed._tag !== "Unusable") return;
		expect(parsed.reason).toContain("sha");
	});

	it("refuses a SHA the marker could not be bound by", () => {
		expect(parseFields("namespace: review\npolarity: PASS\nsha: 03135b\nclause: ok\n")._tag).toBe(
			"Unusable",
		);
	});

	it("refuses an unknown polarity", () => {
		expect(parseFields(`namespace: review\npolarity: MAYBE\nsha: ${HEAD}\nclause: ok\n`)._tag).toBe(
			"Unusable",
		);
	});

	it("refuses a duplicated field instead of letting one silently win", () => {
		const parsed = parseFields(
			`namespace: review\nnamespace: review-code\npolarity: PASS\nsha: ${HEAD}\nclause: ok\n`,
		);
		expect(parsed._tag).toBe("Unusable");
		if (parsed._tag !== "Unusable") return;
		expect(parsed.reason).toContain("twice");
	});

	it("refuses an unknown key rather than dropping the line", () => {
		expect(
			parseFields(`namespace: review\npolarity: PASS\nsha: ${HEAD}\nclause: ok\nrun: 42\n`)._tag,
		).toBe("Unusable");
	});
});

describe("the registry row's byte-level pair", () => {
	it("renders one `<field>\\t<value>` line per field", () => {
		expect(renderMarker(MARKER)).toEqual([
			"namespace\treview-code",
			"polarity\tPASS",
			`sha\t${HEAD}`,
			"clause\tmerge-ready",
		]);
	});

	it("round-trips fields → bytes → lines through the pair the registry binds", () => {
		const composed = emitFromFields(
			`namespace: review\npolarity: FAIL\nsha: ${HEAD}\nclause: two unmet\n`,
		);
		expect(composed._tag).toBe("Composed");
		if (composed._tag !== "Composed") return;
		expect(readToLines(composed.bytes)).toEqual({
			_tag: "Found",
			value: ["namespace\treview", "polarity\tFAIL", `sha\t${HEAD}`, "clause\ttwo unmet"],
		});
	});
});

describe("the type forbids the values a lenient reader would invent", () => {
	it("does not admit a Found carrying an empty SHA", () => {
		const counterexample = {
			_tag: "Found",
			// @ts-expect-error — `""` is not a HeadSha, so "found with no binding" is unrepresentable
			value: {namespace: "review", polarity: "PASS", sha: "", clause: text("ok")},
		} satisfies {_tag: "Found"; value: VerdictMarker};
		expect(counterexample._tag).toBe("Found");
	});

	it("does not admit a polarity outside PASS / FAIL", () => {
		const counterexample = {
			// @ts-expect-error — "APPROVED" is not a Polarity
			polarity: "APPROVED",
			namespace: "review",
			sha: sha(HEAD),
			clause: text("ok"),
		} satisfies VerdictMarker;
		expect(counterexample.namespace).toBe("review");
	});
});
