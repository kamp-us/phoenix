/**
 * `guard i18n-guard check`'s IO boundary, scope resolution and exit taxonomy, over a scripted
 * filesystem.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runI18nGuard} from "./i18n-literal-verb.ts";

const ROOT = "/repo";
const SRC = `${ROOT}/apps/web/src`;
const CONFIG = `${SRC}/i18n/i18n-guard.config.json`;

const run = (options: FakeFsOptions) =>
	Effect.runPromise(
		Effect.provide(runI18nGuard({root: ROOT, cwd: ROOT, env: {}}), fakeFs(options).layer),
	);

const config = (over: Readonly<Record<string, unknown>> = {}): string =>
	JSON.stringify({exempt: {}, unmigrated: {}, ...over});

/**
 * `apps/web/src` holding `i18n/` (the catalog + its config), `lab/` and one component, so a test
 * says only what its own file contains.
 */
const tree = (files: Readonly<Record<string, string>>, configText = config()): FakeFsOptions => ({
	directories: [SRC, `${SRC}/i18n`, `${SRC}/lab`],
	dirs: {
		[SRC]: ["i18n", "lab", "App.tsx"],
		[`${SRC}/i18n`]: ["i18n-guard.config.json", "tr.ts"],
		[`${SRC}/lab`]: ["Exhibit.tsx"],
	},
	files: {
		[CONFIG]: configText,
		[`${SRC}/i18n/tr.ts`]: 'export const tr = {"a.b": "giriş yap"};\n',
		[`${SRC}/lab/Exhibit.tsx`]: 'export const s = "gönder";\n',
		[`${SRC}/App.tsx`]: 'export const s = "load more";\n',
		...files,
	},
});

describe("runI18nGuard", () => {
	it("passes a tree whose only Turkish sits in the catalog and the lab", async () => {
		const outcome = await run(tree({}));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("clean");
	});

	it("seats a Turkish literal on the violation code with nothing on stdout", async () => {
		const outcome = await run(tree({[`${SRC}/App.tsx`]: 'export const s = "giriş yap";\n'}));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("apps/web/src/App.tsx");
		expect(outcome.stderr.join("\n")).toContain("giriş yap");
	});

	it("passes that same literal once the config allows the file", async () => {
		const outcome = await run(
			tree(
				{[`${SRC}/App.tsx`]: 'export const s = "giriş yap";\n'},
				config({
					unmigrated: {"apps/web/src/App.tsx": {ceiling: 1, why: "shell copy, tracked by #7723"}},
				}),
			),
		);
		expect(outcome.code).toBe(0);
	});

	it("reds an allowance whose `why` is empty rather than exempting on it", async () => {
		const outcome = await run(
			tree({}, config({exempt: {"apps/web/src/App.tsx": {ceiling: 1, why: "  "}}})),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("non-empty `why`");
	});

	it("reds a scan that resolved to no file at all", async () => {
		const outcome = await run({
			directories: [SRC, `${SRC}/i18n`],
			dirs: {[SRC]: ["i18n"], [`${SRC}/i18n`]: ["i18n-guard.config.json"]},
			files: {[CONFIG]: config()},
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("zero files");
	});

	it("answers UNKNOWN when a source file cannot be read", async () => {
		const outcome = await run({...tree({}), unreadable: [`${SRC}/App.tsx`]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when a directory cannot be listed, never a narrowed clean", async () => {
		const outcome = await run({...tree({}), dirs: {...tree({}).dirs, [`${SRC}/lab`]: null}});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
