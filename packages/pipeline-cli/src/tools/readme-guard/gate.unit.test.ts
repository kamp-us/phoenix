/**
 * `checkReadmes` over a fake repo dir — the filesystem-seam test (#855, #938/#939).
 * The pure verdict (scope filter, zero-scope fail-close) is covered in
 * `readme-guard.unit.test.ts`; this crosses the IO gate over a real temp dir,
 * asserting the exit-code contract (a clean tree succeeds; a real member without a
 * README, a zero-member scope, or an undeclared packages/* glob all `CheckFailed`)
 * from observable outcomes — never by spawning the bin.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkReadmes} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "readme-guard-gate-"));
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

const mkPackage = (name: string, opts: {pkgJson?: boolean; readme?: boolean}) => {
	const dir = join(root, "packages", name);
	mkdirSync(dir, {recursive: true});
	if (opts.pkgJson) writeFileSync(join(dir, "package.json"), `{"name":"@kampus/${name}"}`, "utf8");
	if (opts.readme) writeFileSync(join(dir, "README.md"), `# ${name}\n`, "utf8");
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkReadmes — the CI exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when every package.json-bearing member has a README", async () => {
		writeWorkspace();
		mkPackage("a", {pkgJson: true, readme: true});
		mkPackage("b", {pkgJson: true, readme: true});
		const exit = await run(checkReadmes(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("IGNORES dead-shell dirs (no package.json) — still SUCCEEDS", async () => {
		writeWorkspace();
		mkPackage("real", {pkgJson: true, readme: true});
		mkPackage("leak-guard", {}); // dead shell: no package.json, no README
		mkPackage("spawn-guard", {}); // dead shell
		const exit = await run(checkReadmes(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when a real member lacks a README", async () => {
		writeWorkspace();
		mkPackage("has", {pkgJson: true, readme: true});
		mkPackage("missing", {pkgJson: true});
		const exit = await run(checkReadmes(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, fail-closed) when zero members are in scope", async () => {
		writeWorkspace();
		mkPackage("dead", {}); // only a dead shell under packages/
		const exit = await run(checkReadmes(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when pnpm-workspace.yaml does not declare packages/*", async () => {
		writeWorkspace(["apps/*", "infra/*"]);
		mkPackage("a", {pkgJson: true, readme: true});
		const exit = await run(checkReadmes(root));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
