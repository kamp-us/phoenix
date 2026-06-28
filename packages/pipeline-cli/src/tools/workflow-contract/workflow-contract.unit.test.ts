import {describe, expect, it} from "vitest";
import {judge, judgeScript, maskNonCode, renderReport, topLevelKeys} from "./workflow-contract.ts";

/** The conformant shape, mirroring the real `.claude/workflows/drive-issue.js`. */
const CONFORMANT = `// drive-issue — the thin repo-local executor.
export const meta = {
	name: "drive-issue",
	description: "Drive one triaged issue through the pipeline.",
	phases: ["Classify", "Implement"],
};

const issue = Number(args && typeof args === "object" ? args.issue : args);
phase("Classify");
log(\`Classifying issue #\${issue}\`);
const out = await agent("do the thing", { schema: {} });
`;

const ruleOf = (file: string, src: string) => judgeScript(file, src).violations.map((v) => v.rule);

describe("maskNonCode", () => {
	it("blanks line + block comments, preserving newlines", () => {
		const out = maskNonCode("a // export default\n/* export default */ b");
		expect(out).not.toMatch(/export\s+default/);
		expect(out.split("\n").length).toBe(2);
		expect(out).toContain("a ");
		expect(out).toContain(" b");
	});

	it("blanks string + template literals so tokens inside them don't leak", () => {
		const out = maskNonCode('const s = "export default"; const t = `export default ${x}`;');
		// the string/template TEXT is masked, but the `${x}` substitution stays code
		expect(out).not.toMatch(/export\s+default/);
		expect(out).toContain("x");
	});

	it("keeps real code visible", () => {
		const out = maskNonCode("export const meta = { name: 1 };");
		expect(out).toContain("export const meta");
		expect(out).toContain("name");
	});
});

describe("topLevelKeys", () => {
	it("returns only depth-0 keys, ignoring nested-object keys", () => {
		const masked = maskNonCode("name: 1, description: 2, nested: { name: 9 }");
		expect(topLevelKeys(masked)).toEqual(["name", "description", "nested"]);
	});
});

describe("judgeScript — conformant", () => {
	it("passes a correctly-shaped script (no violations)", () => {
		expect(judgeScript(".claude/workflows/drive-issue.js", CONFORMANT).violations).toEqual([]);
	});
});

describe("judgeScript — export default (the #1217 load-breaker)", () => {
	it("rejects an export-default function wrapper", () => {
		const src = `export default async function ({ agent, args, phase, log }) {
	phase("Run");
	await agent("x", {});
}`;
		expect(ruleOf("w.js", src)).toContain("export-default");
	});

	it("rejects export default even when a meta export is also present", () => {
		const src = `export const meta = { name: "x", description: "y" };
export default async function () {}`;
		expect(ruleOf("w.js", src)).toContain("export-default");
	});

	it("does NOT trip on `export default` written inside a string or comment", () => {
		const src = `export const meta = { name: "x", description: "export default" };
// here we avoid export default
log("never export default");`;
		expect(ruleOf("w.js", src)).toEqual([]);
	});
});

describe("judgeScript — missing / malformed meta", () => {
	it("rejects a script with no meta export", () => {
		const src = `phase("Run");\nawait agent("x", {});`;
		expect(ruleOf("w.js", src)).toContain("meta-missing");
	});

	it("rejects meta missing required keys (no description)", () => {
		const src = `export const meta = { name: "x", phases: [] };\nphase("Run");`;
		expect(ruleOf("w.js", src)).toContain("meta-keys");
	});

	it("rejects meta missing required keys (no name)", () => {
		const src = `export const meta = { description: "x" };\nphase("Run");`;
		expect(ruleOf("w.js", src)).toContain("meta-keys");
	});

	it("rejects a computed (non-literal) meta", () => {
		const src = `export const meta = buildMeta();\nphase("Run");`;
		expect(ruleOf("w.js", src)).toContain("meta-not-literal");
	});

	it("does not mistake a string value `name:` for the real key (fails closed on missing key)", () => {
		// `name` appears only inside a string VALUE, not as a real key.
		const src = `export const meta = { description: "the name: field" };\nphase("Run");`;
		expect(ruleOf("w.js", src)).toContain("meta-keys");
	});
});

describe("judge + renderReport", () => {
	it("aggregate passes only when every script is clean", () => {
		const clean = judgeScript("a.js", CONFORMANT);
		const dirty = judgeScript("b.js", "export default function () {}");
		expect(judge([clean]).pass).toBe(true);
		expect(judge([clean, dirty]).pass).toBe(false);
	});

	it("report names the file, rule, and a reason on failure", () => {
		const v = judge([judgeScript("b.js", "export default function () {}")]);
		const report = renderReport(v);
		expect(report).toContain("b.js");
		expect(report).toContain("export-default");
	});
});
