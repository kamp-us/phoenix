import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {
	BAD_SECTIONS,
	DECISIONS_AUTHORED,
	DIGEST_UNBINDABLE,
	EMPTY_STDIN,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	TRAIL_BLOCKED,
	TRAIL_EMPTY,
} from "./codes.ts";
import {type DocumentRead, runCompose} from "./compose-verb.ts";
import {AUTHORED, CLEARED_DECISIONS} from "./fixtures.test-support.ts";
import {readDecisionsSection} from "./spec.ts";
import {type DecisionRow, trailOf} from "./trail.ts";

const trailJson = (
	decisions: ReadonlyArray<DecisionRow>,
	unresolved: ReadonlyArray<{ref: string; state: string}> = [],
): string =>
	JSON.stringify(trailOf({source: 9412, kind: "grilling", decisions, unresolved, outOfScope: []}));

const compose = (input: {
	readonly trail?: DocumentRead;
	readonly stdin?: StdinRead;
	readonly decisions?: ReadonlyArray<string>;
}) =>
	Effect.runPromise(
		runCompose({
			trailPath: "trail.json",
			trail: Effect.succeed(input.trail ?? {_tag: "Text", text: trailJson(CLEARED_DECISIONS)}),
			decisions: input.decisions ?? [],
			stdin: Effect.succeed(input.stdin ?? {_tag: "Text", text: AUTHORED}),
		}),
	);

describe("the composed body", () => {
	it("prints the four sections on stdout at exit 0, with the decisions rendered from the trail", async () => {
		const out = await compose({});
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("## Problem");
		expect(readDecisionsSection(out.stdout)).toEqual({
			_tag: "Decisions",
			value: CLEARED_DECISIONS,
		});
	});

	it("renders only the selected subset when --decisions names one", async () => {
		const out = await compose({decisions: ["R1.2"]});
		expect(out.code).toBe(0);
		expect(readDecisionsSection(out.stdout)).toMatchObject({value: [CLEARED_DECISIONS[1]]});
	});

	it("carries no footer — the footer is emit's, because only emit knows the spec digest", async () => {
		expect((await compose({})).stdout).not.toContain("Filed by an agent");
	});
});

describe("the authored half is validated before anything is rendered", () => {
	it("refuses empty stdin", async () => {
		const out = await compose({stdin: {_tag: "Text", text: "   \n"}});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stdout).toBe("");
	});

	it("refuses a fourth section rather than dropping it from the composed spec", async () => {
		const out = await compose({stdin: {_tag: "Text", text: `${AUTHORED}\n## Risks\nr\n`}});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("## Risks");
	});

	it("refuses a preamble above ## Problem rather than dropping it", async () => {
		const out = await compose({stdin: {_tag: "Text", text: `intro\n\n${AUTHORED}`}});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
	});

	it("refuses a stdin body that authors the decisions section itself", async () => {
		const out = await compose({stdin: {_tag: "Text", text: `${AUTHORED}\n## Decisions\n- mine\n`}});
		expect(out.code).toBe(DECISIONS_AUTHORED);
		expect(out.stderr.join("\n")).toContain("rendered from the trail, never authored");
	});

	it("refuses a missing authored section", async () => {
		const out = await compose({stdin: {_tag: "Text", text: "## Problem\nx\n"}});
		expect(out.code).toBe(BAD_SECTIONS);
	});

	it("refuses a machine-local path anywhere in the composed whole", async () => {
		const out = await compose({
			trail: {
				_tag: "Text",
				text: trailJson([
					{ref: "R1.1", provenance: "established", text: "the fixture lives at ~/code/phoenix"},
				]),
			},
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stdout).toBe("");
	});
});

describe("a spec is never composed over an unmade decision", () => {
	it("refuses a blocked trail, naming every unresolved ref", async () => {
		const out = await compose({
			trail: {_tag: "Text", text: trailJson(CLEARED_DECISIONS, [{ref: "R2.2", state: "open"}])},
		});
		expect(out.code).toBe(TRAIL_BLOCKED);
		expect(out.stderr.join("\n")).toContain("R2.2");
		expect(out.stderr.join("\n")).toContain("a decision nobody made");
	});

	it("refuses an empty trail rather than rendering an empty section", async () => {
		const out = await compose({trail: {_tag: "Text", text: trailJson([])}});
		expect(out.code).toBe(TRAIL_EMPTY);
	});

	it("refuses --decisions naming a ref that is not on the trail", async () => {
		const out = await compose({decisions: ["R9.9"]});
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stderr.join("\n")).toContain("R9.9");
	});
});

describe("a trail that could not be read is UNKNOWN, never empty", () => {
	it("seats a failed --trail read on 11", async () => {
		const out = await compose({trail: {_tag: "Failed", reason: "no such file"}});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("seats a trail with no 12-hex digest on 14", async () => {
		const out = await compose({
			trail: {_tag: "Text", text: JSON.stringify({trailDigest: "nope", decisions: []})},
		});
		expect(out.code).toBe(DIGEST_UNBINDABLE);
	});
});
