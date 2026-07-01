import {assert, describe, it} from "@effect/vitest";
import {
	deriveShipDigest,
	groupEntries,
	type ReleaseState,
	resolveReleaseState,
	resolveSection,
	type ShipEntry,
	sectionFor,
} from "./digest.ts";

const entry = (over: Partial<ShipEntry> & {pr: number}): ShipEntry => ({
	title: `entry ${over.pr}`,
	...over,
});

const WINDOW = {since: "2026-06-01", until: "2026-07-01"} as const;

describe("sectionFor — area → Product/Infra split", () => {
	it("maps infra → Infra", () => {
		assert.strictEqual(sectionFor("infra"), "Infra");
	});

	it("maps product → Product", () => {
		assert.strictEqual(sectionFor("product"), "Product");
	});

	it("is case- and whitespace-insensitive", () => {
		assert.strictEqual(sectionFor("  INFRA "), "Infra");
	});

	it("defaults an absent area to Product (surfaced, not dropped)", () => {
		assert.strictEqual(sectionFor(undefined), "Product");
	});

	it("defaults an unrecognized area to Product", () => {
		assert.strictEqual(sectionFor("mystery"), "Product");
	});
});

describe("resolveSection — PR signal preferred, join fallback (issue #1598)", () => {
	it("uses the PR area signal when present (join-free), no issue needed", () => {
		assert.strictEqual(resolveSection(entry({pr: 1, area: "infra"})), "Infra");
		assert.strictEqual(resolveSection(entry({pr: 2, area: "product"})), "Product");
	});

	it("prefers the PR area signal over the join fallback when both are present", () => {
		assert.strictEqual(
			resolveSection(entry({pr: 1, area: "product", joinedArea: "infra"})),
			"Product",
		);
		assert.strictEqual(
			resolveSection(entry({pr: 2, area: "infra", joinedArea: "product"})),
			"Infra",
		);
	});

	it("falls back to the PR→issue→milestone join area when the PR signal is absent", () => {
		assert.strictEqual(resolveSection(entry({pr: 1, joinedArea: "infra"})), "Infra");
		assert.strictEqual(resolveSection(entry({pr: 2, joinedArea: "product"})), "Product");
	});

	it("treats a blank PR signal as absent and consults the join fallback", () => {
		assert.strictEqual(resolveSection(entry({pr: 1, area: "   ", joinedArea: "infra"})), "Infra");
	});

	it("defaults to Product when neither signal is present", () => {
		assert.strictEqual(resolveSection(entry({pr: 1})), "Product");
	});
});

describe("groupEntries — product/infra → milestone → type", () => {
	it("groups by the PR signal join-free, and by the join fallback when it is absent", () => {
		const groups = groupEntries([
			entry({pr: 1, area: "infra", type: "chore"}),
			entry({pr: 2, joinedArea: "infra", type: "chore"}),
			entry({pr: 3, area: "product", type: "feature"}),
		]);
		const infra = groups.find((g) => g.section === "Infra");
		const infraPrs = infra?.milestones.flatMap((m) =>
			m.types.flatMap((t) => t.entries.map((e) => e.pr)),
		);
		assert.deepStrictEqual(infraPrs?.sort(), [1, 2]);
	});

	it("splits entries into Product before Infra", () => {
		const groups = groupEntries([
			entry({pr: 1, area: "infra", type: "chore"}),
			entry({pr: 2, area: "product", type: "feature"}),
		]);
		assert.deepStrictEqual(
			groups.map((g) => g.section),
			["Product", "Infra"],
		);
	});

	it("orders named milestones before the Uncategorized fallback", () => {
		const groups = groupEntries([
			entry({pr: 1, area: "product", milestone: undefined, type: "feature"}),
			entry({pr: 2, area: "product", milestone: "Beta launch", type: "feature"}),
			entry({pr: 3, area: "product", milestone: "Alpha", type: "feature"}),
		]);
		const product = groups.find((g) => g.section === "Product");
		assert.deepStrictEqual(
			product?.milestones.map((m) => m.milestone),
			["Alpha", "Beta launch", "Uncategorized"],
		);
	});

	it("orders types within a milestone by TYPE_ORDER", () => {
		const groups = groupEntries([
			entry({pr: 1, area: "product", milestone: "M", type: "bug"}),
			entry({pr: 2, area: "product", milestone: "M", type: "feature"}),
			entry({pr: 3, area: "product", milestone: "M", type: "chore"}),
		]);
		const types = groups[0]?.milestones[0]?.types.map((t) => t.type);
		assert.deepStrictEqual(types, ["feature", "bug", "chore"]);
	});

	it("routes an entry with no type into the Uncategorized type bucket", () => {
		const groups = groupEntries([entry({pr: 9, area: "product", milestone: "M"})]);
		const types = groups[0]?.milestones[0]?.types;
		assert.strictEqual(types?.length, 1);
		assert.strictEqual(types?.[0]?.type, "Uncategorized");
	});

	it("routes an unknown type into Uncategorized", () => {
		const groups = groupEntries([entry({pr: 9, area: "product", milestone: "M", type: "weird"})]);
		assert.strictEqual(groups[0]?.milestones[0]?.types[0]?.type, "Uncategorized");
	});

	it("preserves input order within a type bucket", () => {
		const groups = groupEntries([
			entry({pr: 10, area: "product", milestone: "M", type: "feature"}),
			entry({pr: 11, area: "product", milestone: "M", type: "feature"}),
		]);
		assert.deepStrictEqual(
			groups[0]?.milestones[0]?.types[0]?.entries.map((e) => e.pr),
			[10, 11],
		);
	});

	it("never loses an entry: total leaf count is conserved", () => {
		const input = [
			entry({pr: 1, area: "product", milestone: "M", type: "feature"}),
			entry({pr: 2, area: "infra", type: "bug"}),
			entry({pr: 3}),
			entry({pr: 4, area: "product", type: "weird"}),
		];
		const total = groupEntries(input).reduce(
			(n, s) =>
				n +
				s.milestones.reduce((m, ms) => m + ms.types.reduce((t, tg) => t + tg.entries.length, 0), 0),
			0,
		);
		assert.strictEqual(total, input.length);
	});
});

describe("deriveShipDigest — founder-facing rendered digest", () => {
	it("emits a windowed heading", () => {
		const md = deriveShipDigest([entry({pr: 1, area: "product", type: "feature"})], WINDOW);
		assert.match(md, /^# Ship digest — 2026-06-01 → 2026-07-01/);
	});

	it("renders ## Product and ## Infra sections", () => {
		const md = deriveShipDigest(
			[
				entry({pr: 1, area: "product", type: "feature", title: "launch page"}),
				entry({pr: 2, area: "infra", type: "chore", title: "pipeline bump"}),
			],
			WINDOW,
		);
		assert.include(md, "## Product");
		assert.include(md, "## Infra");
		assert.include(md, "- launch page (#1)");
		assert.include(md, "- pipeline bump (#2)");
	});

	it("renders milestone and type sub-headings and the PR backlink", () => {
		const md = deriveShipDigest(
			[entry({pr: 42, area: "product", milestone: "Beta", type: "feature", title: "add widget"})],
			WINDOW,
		);
		assert.include(md, "### Beta");
		assert.include(md, "#### Features");
		assert.include(md, "- add widget (#42)");
	});

	it("surfaces an entry with no milestone/type under Uncategorized, never dropping it", () => {
		const md = deriveShipDigest([entry({pr: 13, area: "product", title: "untyped work"})], WINDOW);
		assert.include(md, "### Uncategorized");
		assert.include(md, "#### Uncategorized");
		assert.include(md, "- untyped work (#13)");
	});

	it("notes an empty window rather than erroring", () => {
		const md = deriveShipDigest([], WINDOW);
		assert.include(md, "# Ship digest — 2026-06-01 → 2026-07-01");
		assert.include(md, "Nothing shipped");
	});

	it("ends with a trailing newline", () => {
		const md = deriveShipDigest([entry({pr: 1, area: "product", type: "feature"})], WINDOW);
		assert.isTrue(md.endsWith("\n"));
	});
});

describe("resolveReleaseState — merged-vs-live-to-users axis (ADR 0123)", () => {
	it("passes through each known state", () => {
		for (const state of ["live", "awaiting-release", "dark"] as const) {
			assert.strictEqual(resolveReleaseState(state), state);
		}
	});

	it("is case- and whitespace-insensitive", () => {
		assert.strictEqual(resolveReleaseState("  DARK "), "dark");
		assert.strictEqual(resolveReleaseState("Awaiting-Release"), "awaiting-release");
	});

	it("defaults an absent state to unknown, never live", () => {
		const resolved: ReleaseState = resolveReleaseState(undefined);
		assert.strictEqual(resolved, "unknown");
	});

	it("maps a blank or unrecognized state to unknown, never live", () => {
		assert.strictEqual(resolveReleaseState("   "), "unknown");
		assert.strictEqual(resolveReleaseState("mystery"), "unknown");
	});
});

describe("deriveShipDigest — live/dark inline annotation per entry", () => {
	it("annotates a live entry", () => {
		const md = deriveShipDigest(
			[entry({pr: 1, area: "product", type: "feature", title: "live thing", releaseState: "live"})],
			WINDOW,
		);
		assert.include(md, "- live thing (#1) — live");
	});

	it("annotates a dark entry", () => {
		const md = deriveShipDigest(
			[entry({pr: 2, area: "product", type: "feature", title: "dark thing", releaseState: "dark"})],
			WINDOW,
		);
		assert.include(md, "- dark thing (#2) — dark");
	});

	it("annotates an awaiting-release entry", () => {
		const md = deriveShipDigest(
			[
				entry({
					pr: 3,
					area: "product",
					type: "feature",
					title: "queued thing",
					releaseState: "awaiting-release",
				}),
			],
			WINDOW,
		);
		assert.include(md, "- queued thing (#3) — awaiting release");
	});

	it("annotates a merged entry with no resolvable state as unknown, never live", () => {
		const md = deriveShipDigest(
			[entry({pr: 4, area: "product", type: "feature", title: "mystery thing"})],
			WINDOW,
		);
		assert.include(md, "- mystery thing (#4) — release state unknown");
		assert.notInclude(md, "- mystery thing (#4) — live");
	});
});

describe("deriveShipDigest — the currently-dark / awaiting-release callout section", () => {
	it("surfaces dark and awaiting-release work in a distinct callout, grouped by state", () => {
		const md = deriveShipDigest(
			[
				entry({pr: 1, area: "product", type: "feature", title: "dark feat", releaseState: "dark"}),
				entry({
					pr: 2,
					area: "product",
					type: "feature",
					title: "queued feat",
					releaseState: "awaiting-release",
				}),
				entry({pr: 3, area: "product", type: "feature", title: "live feat", releaseState: "live"}),
			],
			WINDOW,
		);
		assert.include(md, "## Currently dark — awaiting your release");
		assert.include(md, "### dark");
		assert.include(md, "- dark feat (#1)");
		assert.include(md, "### awaiting release");
		assert.include(md, "- queued feat (#2)");
	});

	it("places the dark callout before the Product/Infra grouping", () => {
		const md = deriveShipDigest(
			[entry({pr: 1, area: "product", type: "feature", title: "dark feat", releaseState: "dark"})],
			WINDOW,
		);
		assert.isBelow(
			md.indexOf("## Currently dark — awaiting your release"),
			md.indexOf("## Product"),
		);
	});

	it("does not list a live entry in the dark callout", () => {
		const md = deriveShipDigest(
			[entry({pr: 9, area: "product", type: "feature", title: "live only", releaseState: "live"})],
			WINDOW,
		);
		assert.notInclude(md, "## Currently dark — awaiting your release");
	});

	it("does not assert an unknown-state entry as awaiting-release in the callout", () => {
		const md = deriveShipDigest(
			[entry({pr: 7, area: "product", type: "feature", title: "mystery only"})],
			WINDOW,
		);
		assert.notInclude(md, "## Currently dark — awaiting your release");
	});

	it("omits the callout entirely when nothing is dark or awaiting-release", () => {
		const md = deriveShipDigest(
			[
				entry({pr: 1, area: "product", type: "feature", title: "a", releaseState: "live"}),
				entry({pr: 2, area: "infra", type: "chore", title: "b", releaseState: "live"}),
			],
			WINDOW,
		);
		assert.notInclude(md, "Currently dark");
	});
});
