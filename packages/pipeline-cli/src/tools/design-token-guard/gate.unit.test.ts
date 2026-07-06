/**
 * `checkDesignTokens` + `writeBaseline` over a fake repo dir — the filesystem-seam
 * test (#855, issue #2170). The pure verdict is covered in
 * `design-token-guard.unit.test.ts`; this crosses the IO gate over a real temp tree,
 * asserting the exit-code contract from observable outcomes — never by spawning the bin.
 */
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkDesignTokens, writeBaseline} from "./gate.ts";

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

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

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
