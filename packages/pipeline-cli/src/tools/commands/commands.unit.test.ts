/**
 * Pure-core tests for `commands` (#3316): the registry-sourced tool index.
 *
 * The load-bearing cases: alphabetical ordering (registry order is arbitrary), the
 * `name · description` line shape, and — the rot-proofing that closes AC #4 — that a
 * tool with a missing or blank description is surfaced by `undocumentedTools` (what
 * `check` reds on) while a fully-described registry reports none.
 */
import {describe, expect, it} from "@effect/vitest";
import {renderCompact, type ToolMeta, toolEntries, undocumentedTools} from "./commands.ts";

const registry: ReadonlyArray<ToolMeta> = [
	{name: "verdict", description: "Read/post SHA-bound gate verdicts"},
	{name: "epic-lock", description: "Acquire/release the epic-lock"},
	{name: "campaign", description: "Campaign gate tooling"},
];

describe("toolEntries — alphabetical by name (registry order is arbitrary)", () => {
	it("sorts entries by name without mutating the input", () => {
		const input = [...registry];
		expect(toolEntries(registry).map((t) => t.name)).toEqual(["campaign", "epic-lock", "verdict"]);
		expect(input).toEqual(registry); // input untouched
	});
});

describe("renderCompact — one `name · description` line per tool", () => {
	it("emits alphabetical lines joined by newlines", () => {
		expect(renderCompact(registry)).toBe(
			"campaign · Campaign gate tooling\n" +
				"epic-lock · Acquire/release the epic-lock\n" +
				"verdict · Read/post SHA-bound gate verdicts",
		);
	});

	it("renders an explicit marker for a tool missing a description (never a blank tail)", () => {
		const line = renderCompact([{name: "orphan", description: undefined}]);
		expect(line).toBe("orphan · (undocumented — see `pipeline-cli commands check`)");
	});
});

describe("undocumentedTools — the `check` fail condition (AC #4)", () => {
	it("returns none when every tool carries a description", () => {
		expect(undocumentedTools(registry)).toEqual([]);
	});

	it("surfaces a tool with an undefined description", () => {
		expect(undocumentedTools([...registry, {name: "orphan", description: undefined}])).toEqual([
			"orphan",
		]);
	});

	it("treats a blank/whitespace-only description as missing", () => {
		expect(undocumentedTools([{name: "blank", description: "   "}])).toEqual(["blank"]);
	});

	it("reports missing tools alphabetically", () => {
		const missing = undocumentedTools([
			{name: "zed", description: ""},
			{name: "abe", description: undefined},
		]);
		expect(missing).toEqual(["abe", "zed"]);
	});
});
