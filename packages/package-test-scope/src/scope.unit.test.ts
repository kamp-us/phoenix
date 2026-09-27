import {describe, expect, it} from "vitest";

import {decideScope, type Member, type Scope, type ScopeInput, selects} from "./scope.ts";

const member = (
	name: string,
	dir: string,
	dependencies: ReadonlyArray<string> = [],
	hasTest = true,
): Member => ({name, dir, dependencies, hasTest});

const MEMBERS: ReadonlyArray<Member> = [
	member("@kampus/fabrika-cli", "packages/fabrika-cli"),
	member("@kampus/tuval-sdk", "packages/tuval"),
	member("@kampus/tuval-ui", "packages/tuval-ui", ["@kampus/tuval-sdk", "@kampus/design"]),
	member("@kampus/tuval-cron", "packages/tuval-cron", ["@kampus/tuval-sdk"]),
	member("@kampus/tuval-boot-proof", "packages/tuval-boot-proof", ["@kampus/tuval-cron"], false),
	member("@kampus/design", "packages/design"),
	member("@kampus/db-schema", "packages/db-schema"),
	member("@kampus/admin-grant", "packages/admin-grant"),
	member("@kampus/founder-seed", "packages/founder-seed"),
	member("@kampus/migrations-guard", "packages/migrations-guard"),
	member("@kampus/worker-relevance", "packages/worker-relevance"),
	member("@kampus/preview-seed", "packages/preview-seed", ["@kampus/web", "@kampus/db-schema"]),
	member("@kampus/fts-backfill", "packages/fts-backfill", ["@kampus/web"]),
	member("@kampus/web", "apps/web", ["@kampus/db-schema", "@kampus/design"]),
	member("@kampus-apps/tuval", "apps/tuval", ["@kampus/tuval-ui", "@kampus/design"]),
	member("@kampus/infra", "infra/ci-credentials"),
	member("@kampus/depo-infra", "infra/depo"),
];

const scope = (changedFiles: ReadonlyArray<string> | null, over: Partial<ScopeInput> = {}): Scope =>
	decideScope({event: "pull_request", base: "abc123", changedFiles, members: MEMBERS, ...over});

const packagesOf = (result: Scope): ReadonlyArray<string> => {
	if (result.kind !== "scoped")
		throw new Error(`expected scoped, got ${result.kind}: ${result.reason}`);
	return result.packages;
};

describe("scoped", () => {
	it("runs only fabrika-cli for a fabrika-cli-only diff", () => {
		const result = scope([
			"packages/fabrika-cli/src/build/check.ts",
			"packages/fabrika-cli/src/build/check.unit.test.ts",
		]);
		expect(packagesOf(result)).toEqual(["@kampus/fabrika-cli"]);
		expect(result.reason).toContain("@kampus/fabrika-cli");
	});

	it("scopes a merge_group batch the same way as a pull request", () => {
		expect(packagesOf(scope(["packages/fabrika-cli/src/bin.ts"], {event: "merge_group"}))).toEqual([
			"@kampus/fabrika-cli",
		]);
	});

	it("adds every transitive workspace dependent and drops packages outside the test scope", () => {
		expect(packagesOf(scope(["packages/tuval/src/index.ts"]))).toEqual([
			"@kampus/tuval-cron",
			"@kampus/tuval-sdk",
			"@kampus/tuval-ui",
		]);
	});

	it("follows dependents through an app into packages", () => {
		expect(packagesOf(scope(["packages/db-schema/src/schema.ts"]))).toEqual([
			"@kampus/db-schema",
			"@kampus/fts-backfill",
			"@kampus/preview-seed",
		]);
	});

	it("selects the packages whose tests read an app's files", () => {
		expect(packagesOf(scope(["apps/web/worker/db/drizzle/migrations/0042_x.sql"]))).toEqual([
			"@kampus/admin-grant",
			"@kampus/design",
			"@kampus/founder-seed",
			"@kampus/fts-backfill",
			"@kampus/migrations-guard",
			"@kampus/preview-seed",
			"@kampus/worker-relevance",
		]);
		expect(packagesOf(scope(["apps/tuval/src/shell/ui/tokens.css"]))).toEqual(["@kampus/design"]);
	});

	it("runs the infra package whose suite the job has always run", () => {
		expect(packagesOf(scope(["infra/ci-credentials/index.ts"]))).toEqual(["@kampus/infra"]);
	});
});

describe("full fallback", () => {
	it.each(["push", "workflow_dispatch", ""])("runs every package on a %j event", (event) => {
		expect(scope(["packages/fabrika-cli/src/bin.ts"], {event}).kind).toBe("full");
	});

	it("runs every package when no diff base resolved", () => {
		const result = scope(["packages/fabrika-cli/src/bin.ts"], {base: ""});
		expect(result.kind).toBe("full");
		expect(result.reason).toContain("no diff base");
	});

	it("runs every package when the diff could not be read", () => {
		expect(scope(null).kind).toBe("full");
	});

	it.each([
		".fabrika.schema.json",
		".fabrika.local.schema.json",
		"claude-plugins/fabrika/docs/wire-formats.md",
		"claude-plugins/fabrika/hooks.json",
		"claude-plugins/fabrika/skills/build/SKILL.md",
		"pnpm-workspace.yaml",
		"tsconfig.json",
		"tsconfig.base.json",
		"pnpm-lock.yaml",
		".github/workflows/ci.yml",
		"package.json",
		".decisions/0001-x.md",
		"packages/AGENTS.md",
		"infra/preview-auth-key/key.txt",
		"packages/deleted-package/src/a.ts",
	])("runs every package when the diff touches %s outside every package", (path) => {
		const result = scope(["packages/fabrika-cli/src/bin.ts", path]);
		expect(result.kind).toBe("full");
		expect(result.reason).toContain(path);
	});

	it("runs every package when a member manifest changes", () => {
		const result = scope(["packages/tuval/package.json"]);
		expect(result.kind).toBe("full");
		expect(result.reason).toContain("packages/tuval/package.json");
	});

	it("runs every package when the cross-package read table names a package that is gone", () => {
		const members = MEMBERS.filter((m) => m.name !== "@kampus/design");
		const result = scope(["packages/fabrika-cli/src/bin.ts"], {members});
		expect(result.kind).toBe("full");
		expect(result.reason).toContain("@kampus/design");
	});
});

describe("empty selection", () => {
	it("selects none and says why when only untested or out-of-scope members changed", () => {
		const result = scope(["infra/depo/src/a.ts", "packages/tuval-boot-proof/src/boot.ts"]);
		expect(result).toEqual({
			kind: "none",
			reason: expect.stringContaining("@kampus/depo-infra, @kampus/tuval-boot-proof"),
		});
	});

	it("selects none for an empty diff and says the diff changed no file", () => {
		expect(scope([])).toEqual({kind: "none", reason: expect.stringContaining("changed no file")});
	});
});

describe("selects", () => {
	it("is true for every package on the full run, and for listed packages only when scoped", () => {
		expect(selects({kind: "full", reason: ""}, "@kampus/tuval-sdk")).toBe(true);
		expect(selects({kind: "none", reason: ""}, "@kampus/tuval-sdk")).toBe(false);
		const tuval = scope(["packages/tuval/src/index.ts"]);
		expect(selects(tuval, "@kampus/tuval-sdk")).toBe(true);
		expect(selects(scope(["packages/fabrika-cli/src/a.ts"]), "@kampus/tuval-sdk")).toBe(false);
	});
});
