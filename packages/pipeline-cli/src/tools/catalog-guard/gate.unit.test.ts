/**
 * `checkCatalog` over a fake repo dir — the filesystem-seam test (#855, #2737). The
 * pure verdict is covered in `catalog-guard.unit.test.ts`; this crosses the IO gate
 * over a real temp dir, asserting the exit-code contract (a clean tree succeeds; a
 * hardcoded dep version, and a zero-manifest scope, both `CheckFailed`) from
 * observable outcomes — never by spawning the bin.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkCatalog} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "catalog-guard-gate-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const writeWorkspace = (globs: ReadonlyArray<string> = ["packages/*", "apps/*", "infra/*"]) =>
	writeFileSync(
		join(root, "pnpm-workspace.yaml"),
		`packages:\n${globs.map((g) => `  - ${g}`).join("\n")}\n`,
		"utf8",
	);

const writeRoot = (pkg: Record<string, unknown>) =>
	writeFileSync(join(root, "package.json"), JSON.stringify(pkg), "utf8");

const mkPackage = (name: string, pkg: Record<string, unknown> | null) => {
	const dir = join(root, "packages", name);
	mkdirSync(dir, {recursive: true});
	if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg), "utf8");
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkCatalog — the CI exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when every dep across root + members is on catalog:/workspace:", async () => {
		writeWorkspace();
		writeRoot({name: "phoenix", devDependencies: {turbo: "catalog:"}});
		mkPackage("a", {
			name: "@kampus/a",
			dependencies: {react: "catalog:", "@kampus/b": "workspace:*"},
		});
		const exit = await run(checkCatalog(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("IGNORES dead-shell dirs (no package.json) — still SUCCEEDS", async () => {
		writeWorkspace();
		writeRoot({name: "phoenix"});
		mkPackage("real", {name: "@kampus/real", dependencies: {react: "catalog:"}});
		mkPackage("dead", null); // dead shell: no package.json
		const exit = await run(checkCatalog(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when a member pins a hardcoded version", async () => {
		writeWorkspace();
		writeRoot({name: "phoenix"});
		mkPackage("a", {name: "@kampus/a", dependencies: {bar: "^1.2.3"}});
		const exit = await run(checkCatalog(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when the ROOT manifest pins a hardcoded version", async () => {
		writeWorkspace();
		writeRoot({name: "phoenix", devDependencies: {turbo: "^2.0.0"}});
		mkPackage("a", {name: "@kampus/a", dependencies: {react: "catalog:"}});
		const exit = await run(checkCatalog(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("PASSES a hardcoded dep supplied via the allowlist argument", async () => {
		writeWorkspace();
		writeRoot({name: "phoenix"});
		mkPackage("a", {name: "@kampus/a", dependencies: {bar: "^1.2.3"}});
		const exit = await run(checkCatalog(root, [{name: "bar", reason: "unavoidable"}]));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (fail-closed) when zero manifests are in scope", async () => {
		writeWorkspace();
		// no root package.json, no members with a package.json
		mkPackage("dead", null);
		const exit = await run(checkCatalog(root));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
