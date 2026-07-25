/**
 * `checkDesignTokens` + `writeBaseline` over a fake repo dir — the filesystem-seam
 * test (#855, issue #2170). The pure verdict is covered in
 * `design-token-guard.unit.test.ts`; this crosses the IO gate over a real temp tree,
 * asserting the exit-code contract from observable outcomes — never by spawning the bin.
 */
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit, type FileSystem, type Path} from "effect";
import {CheckFailed, checkDesignTokens, IoError, writeBaseline} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "design-token-guard-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const CSS_DIR = join("apps", "web", "src", "styles");
const CONFIG = join("apps", "web", "src", "styles", "design-token-lint.config.json");

const write = (rel: string, contents: string) => {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), {recursive: true});
	writeFileSync(abs, contents, "utf8");
};

/** `root/<rel>` → `root/<target>` (target need not exist — that's the dangling case). */
const link = (rel: string, target: string) => {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), {recursive: true});
	symlinkSync(join(root, target), abs);
};

const writeConfig = (over: Partial<Record<string, unknown>> = {}) =>
	write(
		CONFIG,
		JSON.stringify({
			externalProperties: [],
			grandfatheredMissingTokens: [],
			rawPxCeilings: {},
			...over,
		}),
	);

// The gate Effects require the `FileSystem | Path` seam (v4 platform migration, #3470);
// provide the live Node layer — the same NodeServices.layer run.ts gives the bin — so these
// real-temp-dir IO tests exercise the actual disk path they assert over.
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
	Effect.runPromiseExit(Effect.provide(effect, NodeServices.layer));
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;
const isIoError = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof IoError;

describe("checkDesignTokens — the CI exit-code gate over a fake tree", () => {
	it("SUCCEEDS on a clean tree (role tokens only)", async () => {
		writeConfig();
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; }`);
		write(
			join(CSS_DIR, "a.css"),
			`.a{ color: var(--accent); border: 1px solid; gap: var(--s-2); }`,
		);
		// --s-2 is declared nowhere here, so declare it to keep the tree clean
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; --s-2: 8px; }`);
		expect(Exit.isSuccess(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("FAILS on a dead var ref (the Toast class)", async () => {
		writeConfig();
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; }`);
		write(join(CSS_DIR, "a.css"), `.a{ color: var(--surface-1); }`);
		expect(isCheckFailed(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("FAILS on a raw hex outside tokens.css", async () => {
		writeConfig();
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; }`);
		write(join(CSS_DIR, "a.css"), `.a{ color: #60a5fa; }`);
		expect(isCheckFailed(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("FAILS on a raw-px regression over the file ceiling", async () => {
		writeConfig({rawPxCeilings: {"apps/web/src/styles/a.css": 1}});
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; }`);
		write(join(CSS_DIR, "a.css"), `.a{ padding: 12px; margin: 16px; }`);
		expect(isCheckFailed(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("SUCCEEDS when raw-px is at the file ceiling (grandfathered debt)", async () => {
		writeConfig({rawPxCeilings: {"apps/web/src/styles/a.css": 2}});
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; }`);
		write(join(CSS_DIR, "a.css"), `.a{ padding: 12px; margin: 16px; }`);
		expect(Exit.isSuccess(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("FAILS closed on zero CSS files", async () => {
		writeConfig();
		mkdirSync(join(root, "apps", "web", "src"), {recursive: true});
		expect(isCheckFailed(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("FAILS closed on a malformed config", async () => {
		write(CONFIG, `{"externalProperties": []}`);
		write(join(CSS_DIR, "a.css"), `.a{ color: red; }`);
		expect(isCheckFailed(await run(checkDesignTokens(root)))).toBe(true);
	});
});

// The walk must keep the lstat semantics of the pre-v4 `Dirent` walk: symlinked DIRS are not
// descended, symlinked `.css` FILES still are. The dir half is a fail-OPEN when it regresses —
// `judge` builds `declaredUniverse` corpus-wide, so declarations behind a link silence a real
// undefined-ref red on a fail-closed gate (ADR 0092) — hence these pin the behaviour directly.
describe("walkCss symlink semantics", () => {
	it("does NOT let a declaration behind a symlinked DIR into the corpus (stays RED)", async () => {
		writeConfig();
		write(join(CSS_DIR, "a.css"), `.a{ color: var(--foo); }`);
		write(join("outside", "o.css"), `:root{ --foo: red; }`);
		link(join(CSS_DIR, "linked"), "outside");
		expect(isCheckFailed(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("still scans a symlinked .css FILE (its violations are caught)", async () => {
		writeConfig();
		write(join(CSS_DIR, "a.css"), `.a{ color: red; }`);
		write(join("outside", "ext.css"), `.x{ color: #60a5fa; }`);
		link(join(CSS_DIR, "linked.css"), join("outside", "ext.css"));
		expect(isCheckFailed(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("ignores a dangling NON-.css symlink under the root (matches the dirent walk)", async () => {
		writeConfig();
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; }`);
		write(join(CSS_DIR, "a.css"), `.a{ color: var(--accent); }`);
		link(join(CSS_DIR, "dangling-dir"), "gone-dir");
		expect(Exit.isSuccess(await run(checkDesignTokens(root)))).toBe(true);
	});

	// The dirent walk pushed any non-directory entry named `*.css` and then `readFileSync`'d it,
	// so a dangling one raised ENOENT and red'd the gate. That is a tree-corruption alarm: a real
	// CSS file replaced by a dangling link must not silently leave scope.
	it("HARD-FAILS (IoError) on a dangling .css symlink under the root", async () => {
		writeConfig();
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; }`);
		write(join(CSS_DIR, "a.css"), `.a{ color: var(--accent); }`);
		link(join(CSS_DIR, "dangling.css"), join("outside", "gone.css"));
		expect(isIoError(await run(checkDesignTokens(root)))).toBe(true);
	});

	it("terminates on a symlink cycle under the root", async () => {
		writeConfig();
		write(join(CSS_DIR, "tokens.css"), `:root{ --accent: #e54d2e; }`);
		write(join(CSS_DIR, "a.css"), `.a{ color: var(--accent); }`);
		link(join(CSS_DIR, "loop"), CSS_DIR);
		expect(Exit.isSuccess(await run(checkDesignTokens(root)))).toBe(true);
	}, 15_000);
});

describe("writeBaseline — regenerate the ceilings", () => {
	it("snapshots each file's raw-px count and preserves the other config fields", async () => {
		writeConfig({
			externalProperties: ["--keep-me"],
			grandfatheredMissingTokens: ["--t-h1"],
			rawPxCeilings: {"stale.css": 99},
		});
		write(join(CSS_DIR, "a.css"), `.a{ padding: 12px; margin: 16px; }`);
		expect(Exit.isSuccess(await run(writeBaseline(root)))).toBe(true);
		const cfg = JSON.parse(readFileSync(join(root, CONFIG), "utf8"));
		expect(cfg.rawPxCeilings).toEqual({"apps/web/src/styles/a.css": 2});
		expect(cfg.externalProperties).toEqual(["--keep-me"]);
		expect(cfg.grandfatheredMissingTokens).toEqual(["--t-h1"]);
	});
});
