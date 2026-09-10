import {describe, expect, it} from "vitest";
import {spliceDependencies, splicePlan} from "./region.ts";

const PLAN = "## Plan (plan-epic)\n\n### Summary\n\nA plan.\n";
const TOPOLOGY = "## Dependencies\n\n- phase 1: #4301\n";

const splice = (body: string, mode: "fresh" | "re-plan") =>
	splicePlan({epic: 4300, body, mode, plan: PLAN, topology: TOPOLOGY});

const ENRICHED = [
	"## Pitch",
	"",
	"A pitch.",
	"",
	"<!-- fabrika:enriched issue=4300 mode=wrap -->",
	"<details>",
	"<summary>Original brief (verbatim)</summary>",
	"",
	"The original brief.",
	"",
	"</details>",
	"",
].join("\n");

describe("splicePlan on a fresh run", () => {
	it("appends the plan and topology below the live bytes, which it does not touch", () => {
		const spliced = splice(ENRICHED, "fresh");
		expect(spliced).toMatchObject({_tag: "Composed"});
		expect(spliced._tag === "Composed" && spliced.body).toBe(
			`${ENRICHED.trimEnd()}\n\n${PLAN.trimEnd()}\n\n${TOPOLOGY.trimEnd()}\n`,
		);
	});

	it("refuses when the body already carries a plan heading — the mode contradicts the body", () => {
		expect(splice(`${ENRICHED}\n${PLAN}\n${TOPOLOGY}`, "fresh")).toEqual({
			_tag: "Unresolvable",
			reason:
				'#4300\'s body carries 1 "## Plan (plan-epic)" headings — the plan region has no single meaning.',
		});
	});
});

describe("splicePlan on a re-plan", () => {
	const PLANNED = `${ENRICHED}\n## Plan (plan-epic)\n\n### Summary\n\nAn older plan.\n\n## Dependencies\n\n- phase 1: #4288\n`;

	it("replaces the bounded region and preserves every byte above it", () => {
		const spliced = splice(PLANNED, "re-plan");
		expect(spliced).toMatchObject({_tag: "Composed"});
		const body = spliced._tag === "Composed" ? spliced.body : "";
		expect(body.startsWith(ENRICHED.trimEnd())).toBe(true);
		expect(body).toContain("A plan.");
		expect(body).not.toContain("An older plan.");
		expect(body).not.toContain("#4288");
	});

	/**
	 * v1 sliced from the `## Dependencies` heading to EOF on the assumption that dependencies are the
	 * last section, destroying anything a human had appended below with no guard at all.
	 */
	it("preserves a human's section below the dependencies block", () => {
		const spliced = splice(`${PLANNED}\n## Notes\n\nA human wrote this.\n`, "re-plan");
		expect(spliced._tag === "Composed" && spliced.body).toContain("A human wrote this.");
	});

	it("refuses when the plan anchor drifted or was deleted", () => {
		expect(splice(ENRICHED, "re-plan")).toEqual({
			_tag: "Unresolvable",
			reason:
				'mode is re-plan and the body carries no "## Plan (plan-epic)" heading — the anchor drifted or was deleted.',
		});
	});

	/** Cutting at a `## Dependencies` heading inside the preserved brief is how a body is destroyed. */
	it("refuses a dependencies heading that resolves inside the preserved brief envelope", () => {
		const trap = [
			"## Pitch",
			"",
			"<!-- fabrika:enriched issue=4300 mode=wrap -->",
			"<details>",
			"<summary>Original brief (verbatim)</summary>",
			"",
			"## Dependencies",
			"",
			"- phase 1: #1",
			"",
			"</details>",
			"",
			"## Plan (plan-epic)",
			"",
			"### Summary",
			"",
			"An older plan.",
			"",
		].join("\n");
		expect(splice(trap, "re-plan")).toMatchObject({
			reason: expect.stringContaining("resolves inside the preserved brief envelope"),
		});
	});

	it("refuses two plan headings", () => {
		expect(splice(`${PLANNED}\n${PLAN}`, "re-plan")).toMatchObject({
			reason: expect.stringContaining('carries 2 "## Plan (plan-epic)" headings'),
		});
	});
});

describe("spliceDependencies", () => {
	const REWRITTEN = "## Dependencies\n\n- phase 1: #4301\n- phase 2: #4303\n";
	const splice = (body: string) => spliceDependencies({epic: 4300, body, topology: REWRITTEN});

	const bodyWith = (topology: string, tail: string): string =>
		`${ENRICHED}\n${PLAN}\n${topology}\n${tail}`;

	it("replaces the block alone, leaving the plan and the envelope byte-identical", () => {
		const before = bodyWith("## Dependencies\n\n- phase 1: #4301, #4302\n", "");
		const spliced = splice(before);
		expect(spliced).toMatchObject({_tag: "Composed"});
		expect(spliced._tag === "Composed" && spliced.body).toBe(`${ENRICHED}\n${PLAN}\n${REWRITTEN}`);
	});

	it("ends the region at a thematic break, so a dated amendment below it survives", () => {
		const amendment = "---\n\n**Amendment** — filed below the block.\n";
		const before = bodyWith("## Dependencies\n\n- phase 1: #4301, #4302\n", amendment);
		const spliced = splice(before);
		expect(spliced._tag === "Composed" && spliced.body).toBe(bodyWith(REWRITTEN, amendment));
	});

	it("refuses a body carrying no Dependencies heading", () => {
		expect(splice(`${ENRICHED}\n${PLAN}`)).toMatchObject({
			reason: expect.stringContaining('carries 0 "## Dependencies" headings'),
		});
	});

	it("refuses two Dependencies headings", () => {
		const twice = bodyWith("## Dependencies\n\n- phase 1: #4301\n", `${TOPOLOGY}\n`);
		expect(splice(twice)).toMatchObject({
			reason: expect.stringContaining('carries 2 "## Dependencies" headings'),
		});
	});

	it("refuses a heading that resolves inside the preserved brief envelope", () => {
		const trap = [
			"## Pitch",
			"",
			"<!-- fabrika:enriched issue=4300 mode=wrap -->",
			"<details>",
			"<summary>Original brief (verbatim)</summary>",
			"",
			"## Dependencies",
			"",
			"- phase 1: #4301",
			"",
			"## Notes",
			"",
			"</details>",
			"",
		].join("\n");
		expect(splice(trap)).toMatchObject({
			reason: expect.stringContaining("resolves inside the preserved brief envelope"),
		});
	});
});
