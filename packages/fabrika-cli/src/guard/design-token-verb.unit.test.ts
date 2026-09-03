/**
 * `guard design-token-guard check`'s IO boundary, walk semantics and exit taxonomy, over a scripted
 * filesystem.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runDesignTokenGuard} from "./design-token-verb.ts";

const ROOT = "/repo";
const APP_SRC = `${ROOT}/apps/web/src`;
const DESIGN_SRC = `${ROOT}/packages/design/src`;
const STYLES = `${ROOT}/packages/design`;
const CONFIG = `${STYLES}/design-token-lint.config.json`;
const TOKENS = `${DESIGN_SRC}/tokens.css`;
const APP_COMPONENT_CSS = `${APP_SRC}/components/App.css`;
const DESIGN_COMPONENT_CSS = `${DESIGN_SRC}/Alert.css`;

const run = (options: FakeFsOptions, writeBaseline = false) =>
	Effect.runPromise(
		Effect.provide(
			runDesignTokenGuard({root: ROOT, cwd: ROOT, env: {}, writeBaseline}),
			fakeFs(options).layer,
		),
	);

const config = (over: Readonly<Record<string, unknown>> = {}): string =>
	JSON.stringify({
		externalProperties: [],
		grandfatheredMissingTokens: [],
		rawPxCeilings: {},
		...over,
	});

/** A tree with the package raw layer plus CSS in both the app and design package. */
const tree = (componentCss: string, configText = config()): FakeFsOptions => ({
	directories: [APP_SRC, `${APP_SRC}/components`, STYLES, DESIGN_SRC],
	dirs: {
		[APP_SRC]: ["components"],
		[`${APP_SRC}/components`]: ["App.css"],
		[STYLES]: ["design-token-lint.config.json"],
		[DESIGN_SRC]: ["tokens.css", "Alert.css"],
	},
	files: {
		[CONFIG]: configText,
		[TOKENS]: ":root {\n  --surface: #101010;\n}\n",
		[APP_COMPONENT_CSS]: ".app { color: var(--surface); }\n",
		[DESIGN_COMPONENT_CSS]: componentCss,
	},
});

describe("runDesignTokenGuard", () => {
	it("passes a component that consumes the seam", async () => {
		const outcome = await run(tree(".a {\n  background: var(--surface);\n}\n"));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("every ref resolves");
	});

	it("seats a dead ref on the violation code with nothing on stdout", async () => {
		const outcome = await run(tree(".a {\n  color: var(--gone);\n}\n"));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("var(--gone)");
	});

	// The raw layer is the one file allowed to carry hex, and the walk must classify it by path.
	it("allows the hex in tokens.css while redding one in a component", async () => {
		const clean = await run(tree(".a {\n  background: var(--surface);\n}\n"));
		expect(clean.code).toBe(0);
		const dirty = await run(tree(".a {\n  background: #ff00aa;\n}\n"));
		expect(dirty.code).toBe(VIOLATION);
	});

	it("annotates the offending line under Actions", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDesignTokenGuard({
					root: ROOT,
					cwd: ROOT,
					env: {GITHUB_ACTIONS: "true"},
					writeBaseline: false,
				}),
				fakeFs(tree(".a {\n  color: var(--gone);\n}\n")).layer,
			),
		);
		expect(
			outcome.stderr.some((l) =>
				l.startsWith("::error file=packages/design/src/Alert.css,line=2::"),
			),
		).toBe(true);
	});

	it("fails closed when no CSS file is in scope", async () => {
		const outcome = await run({
			directories: [APP_SRC, STYLES, DESIGN_SRC],
			dirs: {
				[APP_SRC]: [],
				[STYLES]: ["design-token-lint.config.json"],
				[DESIGN_SRC]: [],
			},
			files: {[CONFIG]: config()},
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	// A present-but-broken allow-list is a broken scope assumption, not a vacuous pass: the ratchet
	// has nothing to judge a file's px count against.
	it("fails closed on a config missing an allow-list key", async () => {
		const outcome = await run(tree(".a {}\n", JSON.stringify({externalProperties: []})));
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when the config is absent", async () => {
		const withoutConfig = tree(".a {}\n");
		const outcome = await run({...withoutConfig, files: {...withoutConfig.files, [CONFIG]: null}});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("is UNKNOWN when a CSS file exists and cannot be read", async () => {
		const outcome = await run({
			...tree(".a {}\n"),
			unreadable: [DESIGN_COMPONENT_CSS],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	// The clean arm is what makes this worth pinning: `tokens.css` still reads, so `judge` sees a
	// non-empty corpus and would have exited 0 over a scan that lost a whole directory.
	it("is UNKNOWN when a directory in the walk cannot be listed, not a pass over the rest", async () => {
		const unlistable = tree(".a {\n  background: var(--surface);\n}\n");
		const outcome = await run({
			...unlistable,
			dirs: {...unlistable.dirs, [DESIGN_SRC]: null},
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(DESIGN_SRC);
	});
});

describe("--write-baseline", () => {
	it("re-snapshots the ceilings and preserves the other config fields", async () => {
		const fake = fakeFs(
			tree(
				".a {\n  margin: 8px;\n}\n",
				config({externalProperties: ["--injected"], note: "keep me"}),
			),
		);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDesignTokenGuard({root: ROOT, cwd: ROOT, env: {}, writeBaseline: true}),
				fake.layer,
			),
		);
		expect(outcome.code).toBe(0);
		const written = JSON.parse(fake.written.get(CONFIG) ?? "{}");
		expect(written.rawPxCeilings).toEqual({"packages/design/src/Alert.css": 1});
		expect(written.externalProperties).toEqual(["--injected"]);
		expect(written.note).toBe("keep me");
	});
});
