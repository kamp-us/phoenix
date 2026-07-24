/**
 * `checkPublishIsolation` over a fake repo dir — the filesystem-seam test (#855, ADR
 * 0201 §3). The pure verdict is covered in `publish-isolation-guard.unit.test.ts`;
 * this crosses the IO gate over a real temp dir, asserting the exit-code contract (a
 * clean published graph succeeds; a workspace: link, a private @kampus dep, a
 * prefix-with-no-member drift, and a zero-scope publish.yml all `CheckFailed`) from
 * observable outcomes — never by spawning the bin.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit, type FileSystem, type Path} from "effect";
import {CheckFailed, checkPublishIsolation} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "publish-isolation-guard-gate-"));
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

// A publish.yml that publishes the given tag prefixes via the `^<prefix>-v(...)` grammar.
const writePublishWorkflow = (prefixes: ReadonlyArray<string> = ["pipeline-cli"]) => {
	mkdirSync(join(root, ".github", "workflows"), {recursive: true});
	const guards = prefixes
		.map((p) => `          if [[ ! "$TAG" =~ ^${p}-v([0-9].*)$ ]]; then exit 1; fi`)
		.join("\n");
	writeFileSync(
		join(root, ".github", "workflows", "publish.yml"),
		`name: publish\non:\n  release:\n    types: [published]\njobs:\n  publish:\n    steps:\n${guards}\n`,
		"utf8",
	);
};

const mkPackage = (name: string, pkg: Record<string, unknown> | null) => {
	const dir = join(root, "packages", name);
	mkdirSync(dir, {recursive: true});
	if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg), "utf8");
};

// The gate Effects require the `FileSystem | Path` seam (v4 platform migration, #3469);
// provide the live Node layer — the same NodeServices.layer run.ts gives the bin.
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
	Effect.runPromiseExit(Effect.provide(effect, NodeServices.layer));

const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkPublishIsolation — the CI exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when the published package's runtime deps are all public/catalog", async () => {
		writeWorkspace();
		writePublishWorkflow(["pipeline-cli"]);
		mkPackage("pipeline-cli", {
			name: "@kampus/pipeline-cli",
			dependencies: {effect: "catalog:", yaml: "catalog:"},
			devDependencies: {vitest: "catalog:"},
		});
		const exit = await run(checkPublishIsolation(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("IGNORES a private, non-published member's dirty graph — only the published set is in scope", async () => {
		writeWorkspace();
		writePublishWorkflow(["pipeline-cli"]);
		mkPackage("pipeline-cli", {name: "@kampus/pipeline-cli", dependencies: {effect: "catalog:"}});
		// This member is NOT published (no matching tag prefix), so its workspace: link is fine.
		mkPackage("pipeline-crew-mcp", {
			name: "@kampus/pipeline-crew-mcp",
			dependencies: {"@kampus/internal-only": "workspace:*"},
		});
		const exit = await run(checkPublishIsolation(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when the published package links a workspace:* dep (the #3802 class)", async () => {
		writeWorkspace();
		writePublishWorkflow(["pipeline-cli"]);
		mkPackage("pipeline-cli", {
			name: "@kampus/pipeline-cli",
			dependencies: {effect: "catalog:", "@kampus/epic-ledger": "workspace:*"},
		});
		const exit = await run(checkPublishIsolation(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when the published package links a private @kampus dep by version", async () => {
		writeWorkspace();
		writePublishWorkflow(["pipeline-cli"]);
		mkPackage("pipeline-cli", {
			name: "@kampus/pipeline-cli",
			dependencies: {"@kampus/leak-guard": "^1.0.0"},
		});
		const exit = await run(checkPublishIsolation(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (fail-closed) when a publish.yml tag prefix maps to no workspace member (drift)", async () => {
		writeWorkspace();
		writePublishWorkflow(["pipeline-cli"]);
		// No member named @kampus/pipeline-cli exists — the prefix can't resolve.
		mkPackage("something-else", {
			name: "@kampus/something-else",
			dependencies: {effect: "catalog:"},
		});
		const exit = await run(checkPublishIsolation(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (fail-closed, zero-scope) when publish.yml declares no release-tag grammar", async () => {
		writeWorkspace();
		writePublishWorkflow([]); // no `^<prefix>-v(...)` anchors → zero published packages
		mkPackage("pipeline-cli", {name: "@kampus/pipeline-cli", dependencies: {effect: "catalog:"}});
		const exit = await run(checkPublishIsolation(root));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
