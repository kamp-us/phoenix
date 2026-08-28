import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, okOut} from "../fakes.test-support.ts";
import {canonicalOriginUrl, inspectSourceRepository, sourceEvidenceLine} from "./source.ts";

const SHA = "b1b99e9773040e25bd6099762491ab23d8ea6910";
const FILES = [
	"package.json",
	"packages/react/package.json",
	"packages/react/src/index.ts",
	"packages/react/src/index.test.ts",
	"packages/react/README.md",
].join("\0");

const script = [
	[/git -C \/local\/xyflow rev-parse --show-toplevel$/, okOut("/upstream\n")],
	[/git -C \/upstream rev-parse --verify HEAD\^\{commit\}$/, okOut(`${SHA}\n`)],
	[/git -C \/upstream remote get-url origin$/, okOut("git@github.com:xyflow/xyflow.git\n")],
	[
		/git -C \/upstream ls-tree -r -z --name-only b1b99e9773040e25bd6099762491ab23d8ea6910$/,
		okOut(`${FILES}\0`),
	],
	[
		/git -C \/upstream show b1b99e9773040e25bd6099762491ab23d8ea6910:package.json$/,
		okOut('{"name":"@xyflow/monorepo","version":"0.0.0","private":true}'),
	],
	[
		/git -C \/upstream show b1b99e9773040e25bd6099762491ab23d8ea6910:packages\/react\/package.json$/,
		okOut('{"name":"@xyflow/react","version":"12.11.5"}'),
	],
	[
		/git -C \/upstream show b1b99e9773040e25bd6099762491ab23d8ea6910:packages\/react\/src\/index.ts$/,
		okOut("export {}"),
	],
	[
		/git -C \/upstream show b1b99e9773040e25bd6099762491ab23d8ea6910:packages\/react\/src\/index.test.ts$/,
		okOut("test('x', () => {})"),
	],
	[
		/git -C \/upstream show b1b99e9773040e25bd6099762491ab23d8ea6910:packages\/react\/README.md$/,
		okOut("# React"),
	],
] as const;

describe("canonicalOriginUrl", () => {
	it("normalizes SSH and HTTPS GitHub origins without credentials or .git", () => {
		expect(canonicalOriginUrl("git@github.com:xyflow/xyflow.git")).toBe(
			"https://github.com/xyflow/xyflow",
		);
		expect(canonicalOriginUrl("https://github.com/xyflow/xyflow.git")).toBe(
			"https://github.com/xyflow/xyflow",
		);
	});

	it("refuses local and unparseable origins", () => {
		expect(canonicalOriginUrl("/Users/me/src/xyflow")).toBeNull();
		expect(canonicalOriginUrl("file:///Users/me/src/xyflow")).toBeNull();
	});
});

describe("inspectSourceRepository", () => {
	it("derives the selected monorepo package and reads source, tests, and docs at HEAD", async () => {
		const shell = fakeShell(script);
		const result = await Effect.runPromise(
			Effect.provide(inspectSourceRepository("/local/xyflow", "@xyflow/react"), shell.layer),
		);
		expect(result).toEqual({
			_tag: "Evidence",
			evidence: {
				origin: "https://github.com/xyflow/xyflow",
				commit: SHA,
				package: "@xyflow/react",
				version: "12.11.5",
				inspected: {
					source: "packages/react/src/index.ts",
					tests: "packages/react/src/index.test.ts",
					docs: "packages/react/README.md",
				},
			},
		});
		expect(shell.calls).toContain(`git -C /upstream ls-tree -r -z --name-only ${SHA}`);
		expect(shell.calls).toContain(`git -C /upstream show ${SHA}:packages/react/src/index.ts`);
		expect(shell.calls).toContain(`git -C /upstream show ${SHA}:packages/react/src/index.test.ts`);
		expect(shell.calls).toContain(`git -C /upstream show ${SHA}:packages/react/README.md`);
		expect(
			shell.calls.some((call) => call.includes("ls-files") || call.includes("show HEAD:")),
		).toBe(false);
	});

	it("keeps the local checkout path out of portable evidence", async () => {
		const shell = fakeShell(script);
		const result = await Effect.runPromise(
			Effect.provide(inspectSourceRepository("/local/xyflow", "@xyflow/react"), shell.layer),
		);
		expect(result._tag).toBe("Evidence");
		if (result._tag === "Evidence") {
			const serialized = JSON.stringify(result.evidence) + sourceEvidenceLine(result.evidence);
			expect(serialized).not.toContain("/local/xyflow");
			expect(serialized).not.toContain("/upstream");
		}
	});

	it("refuses ambiguous monorepos instead of choosing a root or first package", async () => {
		const files = ["packages/a/package.json", "packages/b/package.json"].join("\0");
		const shell = fakeShell([
			[/git -C \/local\/mono rev-parse --show-toplevel$/, okOut("/mono\n")],
			[/git -C \/mono rev-parse --verify HEAD\^\{commit\}$/, okOut(`${SHA}\n`)],
			[/git -C \/mono remote get-url origin$/, okOut("https://github.com/acme/mono.git\n")],
			[
				/git -C \/mono ls-tree -r -z --name-only b1b99e9773040e25bd6099762491ab23d8ea6910$/,
				okOut(`${files}\0`),
			],
			[
				/git -C \/mono show b1b99e9773040e25bd6099762491ab23d8ea6910:packages\/a\/package.json$/,
				okOut('{"name":"a","version":"1.0.0"}'),
			],
			[
				/git -C \/mono show b1b99e9773040e25bd6099762491ab23d8ea6910:packages\/b\/package.json$/,
				okOut('{"name":"b","version":"2.0.0"}'),
			],
		]);
		const result = await Effect.runPromise(
			Effect.provide(inspectSourceRepository("/local/mono", null), shell.layer),
		);
		expect(result).toEqual({
			_tag: "Refused",
			reason:
				"package selection is ambiguous across 2 versioned public manifests; pass --source-package",
		});
	});

	it("refuses a selected package whose version cannot be derived", async () => {
		const files = ["package.json", "src/index.ts", "src/index.test.ts", "README.md"].join("\0");
		const shell = fakeShell([
			[/git -C \/local\/pkg rev-parse --show-toplevel$/, okOut("/pkg\n")],
			[/git -C \/pkg rev-parse --verify HEAD\^\{commit\}$/, okOut(`${SHA}\n`)],
			[/git -C \/pkg remote get-url origin$/, okOut("https://github.com/acme/pkg.git\n")],
			[
				/git -C \/pkg ls-tree -r -z --name-only b1b99e9773040e25bd6099762491ab23d8ea6910$/,
				okOut(`${files}\0`),
			],
			[
				/git -C \/pkg show b1b99e9773040e25bd6099762491ab23d8ea6910:package.json$/,
				okOut('{"name":"pkg"}'),
			],
		]);
		const result = await Effect.runPromise(
			Effect.provide(inspectSourceRepository("/local/pkg", "pkg"), shell.layer),
		);
		expect(result).toEqual({
			_tag: "Refused",
			reason: "package pkg has no unique versioned manifest in the checkout",
		});
	});
});
