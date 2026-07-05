/**
 * Pure-core tests for `fanout-guard` (ADR 0155, #1898): the drift check (a mutation
 * must be classified), the fanned-must-publish check (the fixture pair — a fanned
 * mutation with a publish passes, one without fails), the fail-closed-on-zero verdict
 * (ADR 0092), and the manifest/mutation-key/publisher source parses. No IO — the
 * filesystem seam is crossed in `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type DiscoveredMutation,
	type FanoutGuardFacts,
	judge,
	type ManifestEntry,
	parseManifestEntries,
	parseMutationKeys,
	referencesPublisher,
	renderReport,
} from "./fanout-guard.ts";

const disc = (key: string, feature: string): DiscoveredMutation => ({key, feature});
const man = (key: string, fanned: boolean): ManifestEntry => ({key, fanned});
const facts = (
	discovered: ReadonlyArray<DiscoveredMutation>,
	manifest: ReadonlyArray<ManifestEntry>,
	featurePublishes: ReadonlyMap<string, boolean>,
): FanoutGuardFacts => ({discovered, manifest, featurePublishes});

describe("judge — fail-closed on zero scope (ADR 0092)", () => {
	it("FAILS with zero-scope when no mutations are discovered", () => {
		const verdict = judge(facts([], [man("post.submit", true)], new Map()));
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("zero-scope");
	});
});

describe("judge — drift (every mutation must be classified)", () => {
	it("FAILS with an unclassified discovered mutation", () => {
		const verdict = judge(facts([disc("post.submit", "pano")], [], new Map([["pano", true]])));
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason === "drift" && verdict.unclassified).toEqual([
			"post.submit",
		]);
	});

	it("FAILS with a stale manifest row for a mutation that no longer exists", () => {
		const verdict = judge(
			facts(
				[disc("post.submit", "pano")],
				[man("post.submit", true), man("post.gone", true)],
				new Map([["pano", true]]),
			),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason === "drift" && verdict.stale).toEqual([
			"post.gone",
		]);
	});
});

describe("judge — the fixture pair: a fanned mutation must publish", () => {
	it("PASSES when a fanned mutation's feature references a publish", () => {
		const verdict = judge(
			facts([disc("post.submit", "pano")], [man("post.submit", true)], new Map([["pano", true]])),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.fanned).toBe(1);
	});

	it("FAILS when a fanned mutation's feature omits the publish", () => {
		const verdict = judge(
			facts(
				[disc("post.submit", "pano")],
				[man("post.submit", true)],
				// pano does NOT reference the publisher — the omission the guard exists to catch
				new Map([["pano", false]]),
			),
		);
		expect(verdict.pass).toBe(false);
		expect(
			verdict.pass === false && verdict.reason === "missing-publish" && verdict.omitted,
		).toEqual(["post.submit"]);
	});

	it("a NOT-fanned mutation whose feature omits the publish is fine", () => {
		const verdict = judge(
			facts(
				[disc("bildirim.markRead", "bildirim")],
				[man("bildirim.markRead", false)],
				new Map([["bildirim", false]]),
			),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.fanned).toBe(0);
	});

	it("mixed feature: a fanned + a non-fanned mutation share one publishing feature — passes", () => {
		const verdict = judge(
			facts(
				[disc("post.submit", "pano"), disc("post.saveDraft", "pano")],
				[man("post.submit", true), man("post.saveDraft", false)],
				new Map([["pano", true]]),
			),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.checked).toBe(2);
		expect(verdict.pass && verdict.fanned).toBe(1);
	});
});

describe("renderReport", () => {
	it("names the omitting mutations on a missing-publish fail", () => {
		const report = renderReport({
			pass: false,
			reason: "missing-publish",
			omitted: ["report.resolve"],
		});
		expect(report).toContain("report.resolve");
		expect(report).toContain("WorkerLivePublisher");
	});

	it("names the unclassified mutations on a drift fail", () => {
		const report = renderReport({
			pass: false,
			reason: "drift",
			unclassified: ["post.newthing"],
			stale: [],
		});
		expect(report).toContain("post.newthing");
		expect(report).toContain("UNCLASSIFIED");
	});
});

describe("parseManifestEntries — read {key, fanned} rows from manifest source", () => {
	it("parses fanned + not-fanned rows, ignoring the rationale", () => {
		const source = `
			export const FANNED_MUTATIONS = [
				{key: "post.submit", fanned: true, rationale: "prepends a Post edge"},
				{key: "bildirim.markRead", fanned: false, rationale: "per-user, no connection"},
			];
		`;
		expect(parseManifestEntries(source)).toEqual([
			{key: "post.submit", fanned: true},
			{key: "bildirim.markRead", fanned: false},
		]);
	});

	it("returns [] on an empty/unparseable manifest (gate.ts fails closed on this)", () => {
		expect(parseManifestEntries("export const FANNED_MUTATIONS = [];")).toEqual([]);
	});
});

describe("parseMutationKeys — read Fate.mutation keys from mutations.ts source", () => {
	it('matches the `"entity.verb": Fate.mutation(` declaration shape', () => {
		const source = `
			export const mutations = {
				"post.submit": Fate.mutation({ ... }),
				"comment.add": Fate.mutation(
					{ ... },
				),
			};
		`;
		expect(parseMutationKeys(source)).toEqual(["post.submit", "comment.add"]);
	});

	it("returns [] when a feature declares no mutations", () => {
		expect(parseMutationKeys("export const mutations = {};")).toEqual([]);
	});
});

describe("referencesPublisher — feature-scoped publish detection", () => {
	it("true when the source reaches WorkerLivePublisher", () => {
		expect(referencesPublisher("const live = panoLive(yield* WorkerLivePublisher);")).toBe(true);
	});

	it("false when the source never mentions the publisher", () => {
		expect(referencesPublisher("const marked = yield* bildirim.markRead(user.id, input.id);")).toBe(
			false,
		);
	});
});
