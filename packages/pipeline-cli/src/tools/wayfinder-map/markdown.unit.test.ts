import {assert, describe, it} from "@effect/vitest";
import {cleanMapBody} from "./fixtures.ts";
import {parseMapBody} from "./markdown.ts";

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
