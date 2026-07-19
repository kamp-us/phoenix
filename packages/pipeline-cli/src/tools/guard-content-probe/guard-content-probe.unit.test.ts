import {describe, expect, it} from "vitest";
import {
	FAILCLOSED_GUARD_ADR_RE,
	parseGuardAdrRe,
	probeGuardContent,
} from "./guard-content-probe.ts";

// A faithful slice of the canonical §CP source: the single-quoted GUARD_ADR_RE= line the
// verb parses, plus the double-quoted re-assignment it must NOT capture (mirrors the real
// gh-issue-intake-formats.md §CP block, ADR 0164).
const FORMATS_SLICE = [
	"Some prose about the guard-touching ADR predicate.",
	"GUARD_ADR_RE='guard|invariant|fail-closed|enforcement|relax|loosen|weaken|widen|waive|bypass|exempt'",
	'GUARD_ADR_RE="$(printf \'%s\' "$GA_LIVE" | sed ...)"',
].join("\n");

describe("parseGuardAdrRe — single-source the §CP vocabulary (ADR 0164)", () => {
	it("parses the canonical single-quoted GUARD_ADR_RE= assignment", () => {
		expect(parseGuardAdrRe(FORMATS_SLICE)).toBe(
			"guard|invariant|fail-closed|enforcement|relax|loosen|weaken|widen|waive|bypass|exempt",
		);
	});

	it("ignores the double-quoted re-assignment line (never cross-captures)", () => {
		// The `^GUARD_ADR_RE='` anchor + `[^']*` value excludes the `GUARD_ADR_RE="$(...)"` line.
		expect(parseGuardAdrRe(FORMATS_SLICE)).not.toContain("printf");
	});

	it("falls back to the fail-closed match-everything default on a truncated read", () => {
		expect(parseGuardAdrRe("no assignment here")).toBe(FAILCLOSED_GUARD_ADR_RE);
		expect(FAILCLOSED_GUARD_ADR_RE).toBe(".");
	});
});

const GUARD_RE = parseGuardAdrRe(FORMATS_SLICE);

describe("probeGuardContent — the ADR-0164 content-shape predicate (#3645)", () => {
	describe("fail-closed: an unreadable ADR body is guard-touching", () => {
		it("null body ⇒ guard-touching (delete/404/unreadable head)", () => {
			const r = probeGuardContent(null, GUARD_RE);
			expect(r.guardTouching).toBe(true);
			expect(r.reason).toBe("unreadable-body");
		});

		it("undefined and whitespace-only bodies ⇒ guard-touching", () => {
			expect(probeGuardContent(undefined, GUARD_RE).guardTouching).toBe(true);
			expect(probeGuardContent("   \n\t ", GUARD_RE).guardTouching).toBe(true);
		});
	});

	describe("fail-closed: an uncompilable boundary matches everything", () => {
		it("a broken regex ⇒ guard-touching, never silently match nothing", () => {
			const r = probeGuardContent("# ADR: an ordinary product decision", "(unterminated");
			expect(r.guardTouching).toBe(true);
			expect(r.reason).toBe("uncompilable-regex");
		});

		it("the fail-closed '.' default matches any non-empty body ⇒ guard-touching", () => {
			expect(probeGuardContent("anything", FAILCLOSED_GUARD_ADR_RE).guardTouching).toBe(true);
		});
	});

	describe("guard-vocabulary match (§CP, ADR 0164)", () => {
		it("a guard-relaxing ADR is guard-touching", () => {
			const body = "# ADR 0194\n\nThis decision relaxes the fail-closed enforcement guard.";
			const r = probeGuardContent(body, GUARD_RE);
			expect(r.guardTouching).toBe(true);
			expect(r.reason).toBe("guard-vocabulary-match");
		});

		it("matches case-insensitively (grep -Ei parity)", () => {
			const r = probeGuardContent("We must WEAKEN the INVARIANT here.", GUARD_RE);
			expect(r.guardTouching).toBe(true);
		});

		it("a single vocabulary hit anywhere in the body is enough (conservative over-match)", () => {
			const r = probeGuardContent("Long prose ... bypass ... more prose.", GUARD_RE);
			expect(r.guardTouching).toBe(true);
		});
	});

	describe("no match — an ordinary ADR is not guard-touching", () => {
		it("a product decision with no guard vocabulary classifies not-guard-touching", () => {
			const body = "# ADR 0200\n\nSözlük term pages sort entries by score, newest first.";
			const r = probeGuardContent(body, GUARD_RE);
			expect(r.guardTouching).toBe(false);
			expect(r.reason).toBe("no-match");
		});
	});
});
