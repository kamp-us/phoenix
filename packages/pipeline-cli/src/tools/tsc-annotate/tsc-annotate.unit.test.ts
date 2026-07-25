import {describe, expect, it} from "vitest";
import {
	type AnnotateContext,
	annotationsFor,
	parseDiagnostic,
	renderWorkflowCommand,
} from "./tsc-annotate.ts";

const ctx: AnnotateContext = {
	members: [
		{name: "@kampus/worker-relevance", dir: "packages/worker-relevance"},
		{name: "@kampus/web", dir: "apps/web"},
	],
	root: "/repo",
};

describe("parseDiagnostic — the turbo-prefixed plain form (what CI actually emits)", () => {
	// Verbatim from a real `pnpm turbo run typecheck` failure.
	const line =
		"@kampus/worker-relevance:typecheck: src/__probe.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.";

	it("re-roots the package-relative path onto the package dir", () => {
		expect(parseDiagnostic(line, ctx)).toEqual({
			file: "packages/worker-relevance/src/__probe.ts",
			line: 1,
			column: 14,
			severity: "error",
			code: "TS2322",
			message: "Type 'number' is not assignable to type 'string'.",
		});
	});

	it("renders the workflow command GitHub turns into an inline annotation", () => {
		expect(renderWorkflowCommand(parseDiagnostic(line, ctx)!)).toBe(
			"::error file=packages/worker-relevance/src/__probe.ts,line=1,col=14::TS2322: Type 'number' is not assignable to type 'string'.",
		);
	});
});

describe("parseDiagnostic — the other shapes tsc can emit", () => {
	it("un-prefixed lines are relative to the repo root already", () => {
		expect(parseDiagnostic("src/a.ts(3,5): error TS1005: ';' expected.", ctx)?.file).toBe(
			"src/a.ts",
		);
	});

	it("accepts the pretty `path:line:col - error` form", () => {
		expect(
			parseDiagnostic("@kampus/web:typecheck: src/a.tsx:9:2 - error TS2551: Nope.", ctx),
		).toEqual({
			file: "apps/web/src/a.tsx",
			line: 9,
			column: 2,
			severity: "error",
			code: "TS2551",
			message: "Nope.",
		});
	});

	it("strips ANSI colouring before matching", () => {
		const esc = String.fromCharCode(27);
		const colored = `${esc}[96msrc/a.ts${esc}[0m(2,1): ${esc}[91merror${esc}[0m TS2304: Cannot find name 'x'.`;
		expect(parseDiagnostic(colored, ctx)?.file).toBe("src/a.ts");
	});

	it("makes an absolute path repo-relative", () => {
		expect(parseDiagnostic("/repo/apps/web/src/a.ts(1,1): error TS1: x", ctx)?.file).toBe(
			"apps/web/src/a.ts",
		);
	});

	it("carries severity through — a warning annotates as a warning", () => {
		expect(parseDiagnostic("src/a.ts(1,1): warning TS6133: unused.", ctx)?.severity).toBe(
			"warning",
		);
	});

	it("normalises a leading ./", () => {
		expect(parseDiagnostic("./src/a.ts(1,1): error TS1: x", ctx)?.file).toBe("src/a.ts");
	});
});

describe("parseDiagnostic — non-diagnostic lines are not diagnostics", () => {
	const nonDiagnostics = [
		"",
		"@kampus/web:typecheck: > tsgo -p tsconfig.json",
		"Found 3 errors in 2 files.",
		" Tasks:    0 successful, 1 total",
		"@kampus/web:typecheck: cache bypass, force executing 81ed80673ef6",
		"::error file=x,line=1,col=1::already an annotation",
	];

	for (const line of nonDiagnostics) {
		it(`ignores ${JSON.stringify(line)}`, () => {
			expect(parseDiagnostic(line, ctx)).toBeUndefined();
		});
	}
});

describe("renderWorkflowCommand — workflow-command escaping", () => {
	it("escapes %, CR and LF in the message", () => {
		// A newline in the message would otherwise end the workflow command mid-annotation.
		expect(
			renderWorkflowCommand({
				file: "src/a.ts",
				line: 1,
				column: 1,
				severity: "error",
				code: "TS1",
				message: "100% off\r\nnext",
			}),
		).toBe("::error file=src/a.ts,line=1,col=1::TS1: 100%25 off%0D%0Anext");
	});

	it("escapes : and , inside the file property (they separate properties)", () => {
		expect(
			renderWorkflowCommand({
				file: "src/a,b:c.ts",
				line: 1,
				column: 1,
				severity: "error",
				code: "TS1",
				message: "x",
			}),
		).toBe("::error file=src/a%2Cb%3Ac.ts,line=1,col=1::TS1: x");
	});
});

describe("annotationsFor — whole-output mapping", () => {
	const output = [
		"@kampus/worker-relevance:typecheck: cache bypass",
		"@kampus/worker-relevance:typecheck: src/a.ts(1,2): error TS2322: bad.",
		"@kampus/worker-relevance:typecheck: src/a.ts(1,2): error TS2322: bad.",
		"@kampus/web:typecheck: src/b.ts(3,4): error TS2304: worse.",
		" Tasks:    0 successful, 2 total",
	].join("\n");

	it("emits one annotation per distinct diagnostic, in first-seen order", () => {
		expect(annotationsFor(output, ctx)).toEqual([
			"::error file=packages/worker-relevance/src/a.ts,line=1,col=2::TS2322: bad.",
			"::error file=apps/web/src/b.ts,line=3,col=4::TS2304: worse.",
		]);
	});

	// The shape CI actually gets: turbo prints the package header once, then the task's own
	// lines UNPREFIXED. Without the group fold the path would be annotated repo-root-relative
	// and the annotation would land on a file that doesn't exist.
	it("attributes unprefixed lines to the package whose group header opened them", () => {
		const esc = String.fromCharCode(27);
		const grouped = [
			`${esc}[;31m@kampus/worker-relevance:typecheck${esc}[;0m`,
			"> tsgo -p tsconfig.json",
			"src/__probe.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.",
			"::group::@kampus/web:typecheck",
			"src/app.tsx(7,3): error TS2304: Cannot find name 'z'.",
			"::endgroup::",
			"src/root.ts(1,1): error TS2307: Cannot find module 'q'.",
		].join("\n");

		expect(annotationsFor(grouped, ctx)).toEqual([
			"::error file=packages/worker-relevance/src/__probe.ts,line=1,col=14::TS2322: Type 'number' is not assignable to type 'string'.",
			"::error file=apps/web/src/app.tsx,line=7,col=3::TS2304: Cannot find name 'z'.",
			"::error file=src/root.ts,line=1,col=1::TS2307: Cannot find module 'q'.",
		]);
	});

	it("a per-line prefix still wins over the enclosing group", () => {
		const mixed = [
			"::group::@kampus/web:typecheck",
			"@kampus/worker-relevance:typecheck: src/a.ts(1,1): error TS1: x",
		].join("\n");
		expect(annotationsFor(mixed, ctx)).toEqual([
			"::error file=packages/worker-relevance/src/a.ts,line=1,col=1::TS1: x",
		]);
	});

	it("a clean typecheck produces no annotations", () => {
		expect(
			annotationsFor("@kampus/web:typecheck: > tsgo -p tsconfig.json\n Tasks: 2 successful", ctx),
		).toEqual([]);
	});
});
