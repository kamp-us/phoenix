/**
 * Pure-core tests for `reachability-guard` (ADR 0173, #2529): the reachable pass (a
 * consuming .tsx + a registered journey), both fail modes (missing consumer / missing
 * journey), the exemption pass, the unknown-flag fail, the fail-closed-on-zero verdict
 * (ADR 0092), and the keys.ts / journey-tag source parses. No IO — the filesystem seam is
 * crossed in `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	consumedConstantsIn,
	type FlagDefinition,
	judge,
	parseFlagDefinitions,
	parseJourneyTags,
	type ReachabilityFacts,
	renderReport,
} from "./reachability-guard.ts";

const def = (
	constantName: string,
	flagKey: string,
	exemptReason: string | null = null,
): FlagDefinition => ({constantName, flagKey, exemptReason});

const facts = (
	flagKey: string,
	definitions: ReadonlyArray<FlagDefinition>,
	consuming: ReadonlyArray<string>,
	journeys: ReadonlyArray<string>,
): ReachabilityFacts => ({
	flagKey,
	definitions,
	consumingConstants: new Set(consuming),
	journeyKeys: new Set(journeys),
});

describe("judge — fail-closed on zero scope (ADR 0092)", () => {
	it("FAILS with zero-scope when no flag definitions are parsed", () => {
		const verdict = judge(facts("phoenix-reactions", [], [], []));
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("zero-scope");
	});
});

describe("judge — unknown/unclassified flag fails closed (ADR 0173 §1)", () => {
	it("FAILS with unknown-flag when the key is not declared in keys.ts", () => {
		const verdict = judge(
			facts("made-up-key", [def("PHOENIX_REACTIONS", "phoenix-reactions")], [], []),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("unknown-flag");
	});
});

describe("judge — the reachable pass (consumer + journey)", () => {
	it("PASSES when a .tsx consumes the constant AND a journey e2e is registered", () => {
		const verdict = judge(
			facts(
				"phoenix-reactions",
				[def("PHOENIX_REACTIONS", "phoenix-reactions")],
				["PHOENIX_REACTIONS"],
				["phoenix-reactions"],
			),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.mode).toBe("reachable");
	});
});

describe("judge — the two fail modes name what's missing", () => {
	it("FAILS unreachable with missingConsumer when no .tsx references the constant", () => {
		// The grounding shape: a flag whose journey is registered but whose UI slice is unbuilt.
		const verdict = judge(
			facts(
				"phoenix-karma-gates",
				[def("PHOENIX_KARMA_GATES", "phoenix-karma-gates")],
				[],
				["phoenix-karma-gates"],
			),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("unreachable");
		expect(
			verdict.pass === false && verdict.reason === "unreachable" && verdict.missingConsumer,
		).toBe(true);
		expect(
			verdict.pass === false && verdict.reason === "unreachable" && verdict.missingJourney,
		).toBe(false);
	});

	it("FAILS unreachable with missingJourney when no e2e registers the flag key", () => {
		const verdict = judge(
			facts(
				"phoenix-reactions",
				[def("PHOENIX_REACTIONS", "phoenix-reactions")],
				["PHOENIX_REACTIONS"],
				[],
			),
		);
		expect(verdict.pass).toBe(false);
		expect(
			verdict.pass === false && verdict.reason === "unreachable" && verdict.missingConsumer,
		).toBe(false);
		expect(
			verdict.pass === false && verdict.reason === "unreachable" && verdict.missingJourney,
		).toBe(true);
	});

	it("FAILS unreachable with BOTH missing when neither a consumer nor a journey exists", () => {
		const verdict = judge(
			facts("phoenix-reactions", [def("PHOENIX_REACTIONS", "phoenix-reactions")], [], []),
		);
		expect(
			verdict.pass === false &&
				verdict.reason === "unreachable" &&
				verdict.missingConsumer &&
				verdict.missingJourney,
		).toBe(true);
	});
});

describe("judge — the exemption path (ADR 0173 §3)", () => {
	it("PASSES a UI-less flag that declares @reachability-exempt, needing neither consumer nor journey", () => {
		const verdict = judge(
			facts(
				"pano-feed-edge-cache",
				[
					def(
						"PANO_FEED_EDGE_CACHE",
						"pano-feed-edge-cache",
						"infra edge-cache flag — no user-facing surface by design",
					),
				],
				[],
				[],
			),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.mode).toBe("exempt");
		expect(verdict.pass && verdict.mode === "exempt" && verdict.exemptReason).toContain(
			"edge-cache",
		);
	});
});

describe("renderReport", () => {
	it("names the missing UI consumer on an unreachable fail", () => {
		const report = renderReport({
			pass: false,
			flagKey: "phoenix-karma-gates",
			reason: "unreachable",
			constantName: "PHOENIX_KARMA_GATES",
			missingConsumer: true,
			missingJourney: false,
		});
		expect(report).toContain("MISSING UI CONSUMER");
		expect(report).toContain("PHOENIX_KARMA_GATES");
		expect(report).not.toContain("MISSING JOURNEY E2E");
	});

	it("names the missing journey e2e on an unreachable fail", () => {
		const report = renderReport({
			pass: false,
			flagKey: "phoenix-reactions",
			reason: "unreachable",
			constantName: "PHOENIX_REACTIONS",
			missingConsumer: false,
			missingJourney: true,
		});
		expect(report).toContain("MISSING JOURNEY E2E");
		expect(report).toContain("@journey:phoenix-reactions");
	});

	it("names the unknown flag key on an unknown-flag fail", () => {
		const report = renderReport({pass: false, flagKey: "made-up-key", reason: "unknown-flag"});
		expect(report).toContain("made-up-key");
		expect(report).toContain("not declared");
	});

	it("states the exemption reason on an exempt pass", () => {
		const report = renderReport({
			pass: true,
			flagKey: "pano-feed-edge-cache",
			mode: "exempt",
			exemptReason: "infra edge-cache flag",
		});
		expect(report).toContain("@reachability-exempt");
		expect(report).toContain("infra edge-cache flag");
	});
});

describe("parseFlagDefinitions — read constant/key/exemption rows from keys.ts source", () => {
	it('parses each export const NAME = "flag-key" row', () => {
		const source = `
			/** Pano taslak flag. */
			export const PANO_DRAFT_SAVE = "pano-draft-save";
			/** Reactions flag. */
			export const PHOENIX_REACTIONS = "phoenix-reactions";
		`;
		expect(parseFlagDefinitions(source)).toEqual([
			{constantName: "PANO_DRAFT_SAVE", flagKey: "pano-draft-save", exemptReason: null},
			{constantName: "PHOENIX_REACTIONS", flagKey: "phoenix-reactions", exemptReason: null},
		]);
	});

	it("reads a @reachability-exempt: <reason> marker from the immediately-preceding doc-comment", () => {
		const source = `
			/**
			 * Edge-cache containment flag.
			 * @reachability-exempt: infra edge-cache flag — no user-facing surface by design.
			 */
			export const PANO_FEED_EDGE_CACHE = "pano-feed-edge-cache";
		`;
		const defs = parseFlagDefinitions(source);
		expect(defs).toHaveLength(1);
		expect(defs[0]?.exemptReason).toBe("infra edge-cache flag — no user-facing surface by design.");
	});

	it("does not leak a distant comment's marker onto an unrelated later flag", () => {
		const source = `
			/**
			 * @reachability-exempt: infra flag.
			 */
			export const PANO_FEED_EDGE_CACHE = "pano-feed-edge-cache";
			/** A normal user-facing flag. */
			export const PHOENIX_REACTIONS = "phoenix-reactions";
		`;
		const defs = parseFlagDefinitions(source);
		expect(defs.find((d) => d.constantName === "PANO_FEED_EDGE_CACHE")?.exemptReason).toBe(
			"infra flag.",
		);
		expect(defs.find((d) => d.constantName === "PHOENIX_REACTIONS")?.exemptReason).toBeNull();
	});

	it("returns [] on a module with no flag definitions", () => {
		expect(parseFlagDefinitions("export const x = 1;")).toEqual([]);
	});
});

describe("consumedConstantsIn — whole-word .tsx reference detection", () => {
	it("matches a constant imported and used in a component", () => {
		const source = `import {PHOENIX_REACTIONS} from "../../flags/keys";\n<FlagGate flag={PHOENIX_REACTIONS} />`;
		expect(consumedConstantsIn(source, ["PHOENIX_REACTIONS", "PANO_DRAFT_SAVE"])).toEqual([
			"PHOENIX_REACTIONS",
		]);
	});

	it("does not match a constant name embedded in a longer identifier", () => {
		expect(consumedConstantsIn("const PANO_BASE_FEED_EDGE = 1;", ["PANO_BASE_FEED"])).toEqual([]);
	});
});

describe("parseJourneyTags — read @journey:<key> registrations from a spec source", () => {
	it("extracts the flag key from a @journey tag in a describe title", () => {
		const source = `test.describe("Reaction bar @journey:phoenix-reactions", () => {});`;
		expect(parseJourneyTags(source)).toEqual(["phoenix-reactions"]);
	});

	it("returns [] when a spec registers no journey", () => {
		expect(parseJourneyTags(`test("plain", () => {});`)).toEqual([]);
	});
});
