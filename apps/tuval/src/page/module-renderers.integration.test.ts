/**
 * The page server's half of a module renderer reference (ADR 0359), against a real Vite: the loader
 * module it generates is served under its virtual id with the fixture's `import()` inside, and a
 * specifier nothing installed here answers to refuses the page at boot with the specifier in the
 * sentence — the terminal, not a blank tab, is where a founder learns the package is not there.
 *
 * The fixture behind the `import()` is not fetched here on purpose. Transforming a `.tsx` starts
 * Vite's dependency discovery, and a `close()` that lands while that scan is in flight never settles
 * (Vite 8.1.5; `waitForRequestsIdle()` before the close is the cure, and `servePage` hands out no
 * server to wait on). The fixture's own load path is `module-renderers.unit.test.ts`, through the
 * same `import()` the served module carries.
 */

import {dirname} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Exit, Schema} from "effect";
import type {TransportServer} from "../shell/transport/server.ts";
import {PageServerFailed, servePage} from "./dev-server.ts";

const appRoot = dirname(dirname(import.meta.dirname));
const FIXTURE_REF = "/src/demo/module-window.tsx";
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

describe("the served module renderers", () => {
	it.live(
		"the virtual module carries one import() per reference, keyed by the reference",
		() =>
			Effect.gen(function* () {
				const page = yield* servePage({
					root: appRoot,
					transport,
					port: 0,
					moduleRenderers: [FIXTURE_REF],
				});
				const loader = yield* text(new URL(VIRTUAL_URL, page.url));
				assert.include(loader, `"${FIXTURE_REF}"`);
				assert.include(loader, "import(");
				assert.include(loader, "module-window.tsx");
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a specifier that does not resolve from the app root refuses the page at boot, by name",
		() =>
			Effect.gen(function* () {
				const exit = yield* servePage({
					root: appRoot,
					transport,
					port: 0,
					moduleRenderers: ["@tuval-nobody/not-installed/window"],
				}).pipe(Effect.scoped, Effect.exit);
				assert.ok(Exit.isFailure(exit), "the page refused to serve");
				if (!Exit.isFailure(exit)) return;
				const failure = Exit.isFailure(exit) ? exit.cause : null;
				const message = String(failure);
				assert.include(message, "@tuval-nobody/not-installed/window");
				assert.include(message, "does not resolve");
				assert.include(message, PageServerFailed.name);
			}),
		TIMEOUT,
	);
});
