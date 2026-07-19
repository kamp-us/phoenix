import {assert, describe, it} from "@effect/vitest";
import {cleanMapBody} from "./fixtures.ts";
import {parseMapBody} from "./markdown.ts";
import {validateMap} from "./validate.ts";

/** The #2421 §worked-example map verbatim — every list item wraps onto a continuation line. */
const wrappedWorkedExample = [
	"## Destination",
	"kamp.us has a working invite (kefil) flow: an existing yazar can vouch a new person in, and",
	"that person lands as a çaylak with a clear first-run path — no founder in the loop.",
	"",
	"## Decisions-so-far",
	"- Invites are karma-gated, not seat-gated — a yazar spends no quota, the çaylak's own karma",
	"  ramp is the throttle. — from #101",
	"- The invite artifact is a single-use signed link, not an in-app request/approve handshake. — from #102",
	"",
	"## Open frontier",
	"- #103 — Investigation: does better-auth's session model let us mint a single-use invite token",
	"  without a new table, or do we need an `invite` store of record?",
	"- #104 — Decision (founder-decision-fork): should an invited çaylak start at 0 karma or inherit",
	"  a small vouch-backed starting balance? (options + trade-offs surfaced; awaiting founder)",
	"",
	"## Graduated fog",
	"- #101 — Decided invites are karma-gated. → spawned #104 (starting-balance question)",
	"- #102 — Decided the artifact is a signed link. → spawned #103 (token storage investigation)",
	"",
].join("\n");

describe("parseMapBody — the four sections", () => {
	it("parses the canonical map body into all four sections", () => {
		const m = parseMapBody(cleanMapBody);
		assert.strictEqual(m.destination.present, true);
		assert.match(m.destination.text, /invite \(kefil\) flow/);
		assert.strictEqual(m.decisionsSoFar.present, true);
		assert.strictEqual(m.decisionsSoFar.entries.length, 2);
		assert.strictEqual(m.openFrontier.present, true);
		assert.strictEqual(m.openFrontier.entries.length, 2);
		assert.strictEqual(m.graduatedFog.present, true);
		assert.strictEqual(m.graduatedFog.entries.length, 2);
	});

	it("records an absent section as present:false with no entries", () => {
		const m = parseMapBody("## Destination\nsomewhere\n");
		assert.strictEqual(m.destination.present, true);
		assert.strictEqual(m.decisionsSoFar.present, false);
		assert.deepStrictEqual(m.decisionsSoFar.entries, []);
		assert.strictEqual(m.openFrontier.present, false);
		assert.strictEqual(m.graduatedFog.present, false);
	});

	it("an empty body yields four absent sections", () => {
		const m = parseMapBody("");
		assert.strictEqual(m.destination.present, false);
		assert.strictEqual(m.destination.text, "");
		assert.strictEqual(m.decisionsSoFar.present, false);
		assert.strictEqual(m.openFrontier.present, false);
		assert.strictEqual(m.graduatedFog.present, false);
	});
});

describe("parseMapBody — decision entries", () => {
	it("captures the `— from #N` attribution", () => {
		const m = parseMapBody(cleanMapBody);
		assert.deepStrictEqual(
			m.decisionsSoFar.entries.map((d) => d.fromIssue),
			[101, 102],
		);
	});

	it("a decision with no from-ref leaves fromIssue undefined", () => {
		const m = parseMapBody("## Decisions-so-far\n- We chose X.\n");
		assert.strictEqual(m.decisionsSoFar.entries.length, 1);
		assert.strictEqual(m.decisionsSoFar.entries[0]?.fromIssue, undefined);
	});

	it("folds a wrapped item's continuation line, extracting its `— from #N` (#2426)", () => {
		// The #2421 §worked-example map: a well-formed decision whose `— from #N`
		// attribution wraps onto an indented continuation line must parse clean, not
		// spuriously yield MALFORMED_DECISION_ENTRY.
		const m = parseMapBody(wrappedWorkedExample);
		assert.strictEqual(m.decisionsSoFar.entries.length, 2);
		assert.deepStrictEqual(
			m.decisionsSoFar.entries.map((d) => d.fromIssue),
			[101, 102],
		);
	});
});

describe("parseMapBody — the wrapped worked example validates clean (#2426)", () => {
	it("no MALFORMED_DECISION_ENTRY when refs sit on continuation lines", () => {
		// Grounded repro of the FAIL: parsing the verbatim #2421 worked example, whose
		// every item wraps, must extract each ref from its continuation line and so
		// yield a defect-free map — not a spurious MALFORMED_* set.
		const map = parseMapBody(wrappedWorkedExample);
		assert.deepStrictEqual(
			map.decisionsSoFar.entries.map((d) => d.fromIssue),
			[101, 102],
		);
		assert.deepStrictEqual(
			map.openFrontier.entries.map((t) => t.issue),
			[103, 104],
		);
		assert.deepStrictEqual(
			map.graduatedFog.entries.map((e) => e.issue),
			[101, 102],
		);
		const defects = validateMap({number: 100, map, subIssues: [101, 102, 103, 104]});
		assert.deepStrictEqual(defects, []);
	});
});

describe("parseMapBody — CHART-time seed attribution `— from #<MAP>` (#3405)", () => {
	// The sanctioned seed idiom (formats §The four sections): a CHART-time founder
	// given has no frontier ticket to cite, so it is attributed the map's OWN number
	// (`— from #100` for map #100). That form already parses to a resolvable origin,
	// so a map seeded per the documented idiom validates clean — no validator change.
	it("a seed row `— from #<MAP>` yields a resolvable origin and validates clean", () => {
		const body = [
			"## Destination",
			"A working invite flow.",
			"",
			"## Decisions-so-far",
			"- The path is vouch-gated (kefil), not open signup — a founder given. — from #100 (@founder)",
			"- Invites are karma-gated. — from #101",
			"",
			"## Open frontier",
			"- #103 — Investigation: token storage?",
			"",
			"## Graduated fog",
			"- #101 — Decided karma-gated.",
		].join("\n");
		const map = parseMapBody(body);
		assert.deepStrictEqual(
			map.decisionsSoFar.entries.map((d) => d.fromIssue),
			[100, 101],
		);
		const defects = validateMap({number: 100, map, subIssues: [101, 103]});
		assert.notInclude(
			defects.map((d) => d.type),
			"MALFORMED_DECISION_ENTRY",
		);
	});

	it("a truly-unattributed seed (no `— from #N`) is still rejected", () => {
		// The floor is not loosened: a given with no resolvable origin still trips
		// MALFORMED_DECISION_ENTRY — `— from #<MAP>` is the sanctioned form, an absent
		// ref is not.
		const body = ["## Decisions-so-far", "- The path is vouch-gated, not open signup."].join("\n");
		const map = parseMapBody(body);
		assert.strictEqual(map.decisionsSoFar.entries[0]?.fromIssue, undefined);
		const defects = validateMap({number: 100, map, subIssues: []});
		assert.include(
			defects.map((d) => d.type),
			"MALFORMED_DECISION_ENTRY",
		);
	});
});

describe("parseMapBody — frontier entries", () => {
	it("captures the sub-issue ref and the founder-decision-fork flag", () => {
		const m = parseMapBody(cleanMapBody);
		assert.deepStrictEqual(
			m.openFrontier.entries.map((t) => t.issue),
			[103, 104],
		);
		assert.deepStrictEqual(
			m.openFrontier.entries.map((t) => t.founderDecisionFork),
			[false, true],
		);
	});

	it("a frontier line with no `#N` leaves issue undefined", () => {
		const m = parseMapBody("## Open frontier\n- Investigation: how do invites work?\n");
		assert.strictEqual(m.openFrontier.entries[0]?.issue, undefined);
	});
});

describe("parseMapBody — fog entries", () => {
	it("reads the graduated issue as the subject, spawned refs separately", () => {
		const m = parseMapBody(cleanMapBody);
		assert.deepStrictEqual(
			m.graduatedFog.entries.map((e) => e.issue),
			[101, 102],
		);
		assert.deepStrictEqual(m.graduatedFog.entries[0]?.spawned, [104]);
		assert.deepStrictEqual(m.graduatedFog.entries[1]?.spawned, [103]);
	});

	it("a fog line whose only ref is a spawned ref still names its subject", () => {
		// `#150 → spawned #151`: #150 is the subject, #151 the follow-on.
		const m = parseMapBody("## Graduated fog\n- #150 — Decided Y. → spawned #151\n");
		assert.strictEqual(m.graduatedFog.entries[0]?.issue, 150);
		assert.deepStrictEqual(m.graduatedFog.entries[0]?.spawned, [151]);
	});
});

describe("parseMapBody — tolerant heading recognition", () => {
	it("recognizes case and punctuation drift in headings", () => {
		const body = [
			"## destination",
			"there",
			"### Decisions So Far",
			"- Chose X. — from #1",
			"## OPEN FRONTIER",
			"- #2 — Q?",
			"## graduated-fog",
			"- #3 — done.",
		].join("\n");
		const m = parseMapBody(body);
		assert.strictEqual(m.destination.present, true);
		assert.strictEqual(m.decisionsSoFar.present, true);
		assert.strictEqual(m.openFrontier.present, true);
		assert.strictEqual(m.graduatedFog.present, true);
	});

	it("stops a section at the next same-or-higher-level heading", () => {
		const m = parseMapBody(cleanMapBody);
		// Destination text must not bleed into the Decisions section.
		assert.notMatch(m.destination.text, /karma-gated/);
	});
});
