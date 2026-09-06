/**
 * The page server's half of a module renderer reference (ADR 0359), against a real Vite: the loader
 * module it generates is served under its virtual id with the fixture's `import()` inside, and a
 * specifier nothing installed answers to refuses the page at boot with the specifier in the
 * sentence — the terminal, not a blank tab, is where a founder learns the package is not there.
 *
 * The base each specifier resolves from is the config module that declared its row, not the app root
 * (#8262), so the third case here is the install the app root has no answer for at all: a package
 * under a config directory outside the tree. It is built on disk rather than described, because what
 * is under test is Node package resolution and Vite's file serving, and a fake of either would agree
 * with whatever this file believed.
 *
 * The in-tree fixture behind the root-relative `import()` is not fetched here on purpose.
 * Transforming a `.tsx` starts Vite's dependency discovery, and a `close()` that lands while that
 * scan is in flight never settles (Vite 8.1.5; `waitForRequestsIdle()` before the close is the cure,
 * and `servePage` hands out no server to wait on). The fixture's own load path is
 * `module-renderers.unit.test.ts`, through the same `import()` the served module carries. The
 * out-of-tree package below imports nothing for the same reason.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterAll, assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Schema} from "effect";
import type {TransportServer} from "../shell/transport/server.ts";
import {PageServerFailed, servePage} from "./dev-server.ts";

const appRoot = dirname(dirname(import.meta.dirname));
const FIXTURE_REF = "/src/demo/module-window.tsx";
const IN_TREE_CONFIG = join(appRoot, ".tuval", "tuval.config.ts");
/** How Vite spells a `\0`-prefixed virtual id in a URL. */
const VIRTUAL_URL = "/@id/__x00__virtual:tuval/module-renderers";
const TIMEOUT = 30_000;

/** The page server needs a launch URL to answer and a fence to tell; nothing here attaches. */
const transport: TransportServer = {
	port: 1,
	publishRegistry: Effect.void,
	launchUrl: "ws://127.0.0.1:1/?token=none",
	admitLoopbackPort: () => {},
};

class FetchFailed extends Schema.TaggedError<FetchFailed>()("FetchFailed", {
	cause: Schema.Defect(),
}) {}

const text = (url: URL) =>
	Effect.tryPromise({
		try: () => fetch(url).then((response) => response.text()),
		catch: (cause) => new FetchFailed({cause}),
	});

const tempDirs: string[] = [];
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, {recursive: true, force: true});
});

/**
 * A config directory nowhere near the app root, holding one installed renderer package: the shape
 * `~/.tuval` has once a founder runs `pnpm add` beside their own config. The package's window module
 * is plain JavaScript and imports nothing, so serving it starts no dependency scan.
 */
const configWithInstalledRenderer = (): {readonly config: string; readonly file: string} => {
	// realpath: macOS resolves /var to /private/var, and Vite answers with the real path.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-config-")));
	tempDirs.push(dir);
	const pkg = join(dir, "node_modules", "@tuval-fixture", "win");
	mkdirSync(pkg, {recursive: true});
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "@tuval-fixture/win",
			version: "1.0.0",
			type: "module",
			exports: {"./window": "./window.js"},
		}),
	);
	writeFileSync(
		join(pkg, "window.js"),
		'export const admits = () => true;\nexport default {kind: "module", render: () => "installed-beside-the-config"};\n',
	);
	writeFileSync(join(dir, "tuval.config.ts"), "export default {version: 1, programs: []};\n");
	return {config: join(dir, "tuval.config.ts"), file: join(pkg, "window.js")};
};

describe("the served module renderers", () => {
	it.live(
		"the virtual module carries one import() per reference, keyed by the reference",
		() =>
			Effect.gen(function* () {
				const page = yield* servePage({
					root: appRoot,
					transport,
					port: 0,
					moduleRenderers: [{ref: FIXTURE_REF, origin: IN_TREE_CONFIG}],
				});
				const loader = yield* text(new URL(VIRTUAL_URL, page.url));
				assert.include(loader, `"${FIXTURE_REF}"`);
				assert.include(loader, "import(");
				assert.include(loader, "module-window.tsx");
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a specifier that resolves from neither refuses the page at boot, naming its config",
		() =>
			Effect.gen(function* () {
				const {config} = configWithInstalledRenderer();
				const exit = yield* servePage({
					root: appRoot,
					transport,
					port: 0,
					moduleRenderers: [{ref: "@tuval-nobody/not-installed/window", origin: config}],
				}).pipe(Effect.scoped, Effect.exit);
				assert.ok(Exit.isFailure(exit), "the page refused to serve");
				if (!Exit.isFailure(exit)) return;
				const message = String(exit.cause);
				assert.include(message, "@tuval-nobody/not-installed/window");
				assert.include(message, "does not resolve");
				assert.include(message, config);
				assert.notInclude(message, `does not resolve from ${appRoot}`);
				assert.include(message, PageServerFailed.name);
			}),
		TIMEOUT,
	);

	it.live(
		"a package installed beside a config outside the app root resolves, and the page serves it",
		() =>
			Effect.gen(function* () {
				const {config, file} = configWithInstalledRenderer();
				const page = yield* servePage({
					root: appRoot,
					transport,
					port: 0,
					moduleRenderers: [{ref: "@tuval-fixture/win/window", origin: config}],
				});
				const loader = yield* text(new URL(VIRTUAL_URL, page.url));
				assert.include(loader, '"@tuval-fixture/win/window"');
				// The import Vite rewrote is the file itself, reached from the config that declared
				// the row — the app root holds no such package and never resolved it.
				assert.include(loader, file);
				const served = yield* text(new URL(`/@fs${file}`, page.url));
				assert.include(served, "installed-beside-the-config");
			}).pipe(Effect.scoped),
		TIMEOUT,
	);
});
