/**
 * The page, served — the other half of [#7780](https://github.com/kamp-us/phoenix/issues/7780).
 *
 * Vite runs **inside the kernel process**, through its Node API rather than as a second command,
 * and that is why `pnpm dev` is one process. The launch token is minted per boot and kept in memory
 * (`../shell/host/serve.ts`); a separate `vite` would have to be handed that token through a file or
 * an environment variable, and a token on disk outlives the boot that minted it. Here the middleware
 * answering `/__tuval/launch` closes over the URL directly.
 *
 * `vite` is a devDependency and is imported dynamically for that reason: `node src/bin.ts --no-page`
 * boots a kernel with no bundler present, and a static import would make the bundler a runtime
 * requirement of the app.
 *
 * One launch binds two ports — this one and the socket's — so the browser's WebSocket upgrade
 * carries *this* server's origin. The transport's fence is built from the socket's port, so it has
 * to be told this one, and that is why this module takes the transport rather than its URL (#7560).
 */

import {Effect, Schema} from "effect";
import type {TransportServer} from "../shell/transport/server.ts";

/** The page did not start. The kernel is unaffected — the bin reports this and keeps running. */
export class PageServerFailed extends Schema.TaggedError<PageServerFailed>()(
	"tuval/page/PageServerFailed",
	{cause: Schema.Defect()},
) {
	override get message(): string {
		return `the page server did not start: ${String(this.cause)}`;
	}
}

const attempt = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new PageServerFailed({cause})});

export interface PageServerOptions {
	/** The app's own root — where `index.html` lives. */
	readonly root: string;
	/**
	 * The socket this page attaches to. Its launch URL is what `/__tuval/launch` answers, and its
	 * origin fence is told this server's port the moment Vite binds — passing the transport rather
	 * than its URL is what makes those two one act, so a served page's origin is never unadmitted.
	 */
	readonly transport: TransportServer;
	/** `0` picks a free port, which is what a second `pnpm dev` on one machine needs. */
	readonly port: number;
	/**
	 * The `kind: "module"` renderer specifiers the booted rows declared (`moduleRendererRefs`,
	 * `../shell/window/renderer.ts`), each one the page has to load (ADR 0359). Absent means none:
	 * a proof that serves the page over its own rows names none and the page loads nothing.
	 */
	readonly moduleRenderers?: ReadonlyArray<string>;
}

export interface PageServer {
	/** What the founder opens. */
	readonly url: string;
	/** The port `url` names — the port whose loopback origins the transport now admits. */
	readonly port: number;
}

export const LAUNCH_ENDPOINT = "/__tuval/launch";

/**
 * The page's loader module, generated here from the rows and imported by `./boot.tsx` under this
 * one id; `./assets.d.ts` declares its shape. A bare specifier cannot be `import()`ed from the
 * browser by value — Vite rewrites only the imports it can read statically — so the specifiers are
 * written into a module Vite reads like any other, and are resolved, prebundled and served the way
 * the app's own imports are. The `\0` prefix on the resolved id is Rollup's convention for a module
 * with no file behind it, and keeps every other plugin from trying to find one.
 */
export const MODULE_RENDERERS_ID = "virtual:tuval/module-renderers";
const RESOLVED_MODULE_RENDERERS_ID = `\0${MODULE_RENDERERS_ID}`;

/**
 * A string as a JavaScript string literal. `JSON.stringify` is the escape, plus the two characters
 * it leaves raw that JavaScript source treats as line terminators (U+2028, U+2029): inside a JSON
 * string they are legal, inside a JS literal they end the line, and this string becomes code.
 */
const sourceLiteral = (value: string): string =>
	JSON.stringify(value)
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");

/**
 * The source of the loader module: one `import()` per reference, keyed by the reference string the
 * row wrote. Both are written through `sourceLiteral`, so a specifier is a string literal in the
 * output whatever characters it holds — this is generated code, and a row's string is data to it.
 */
export const moduleRenderersSource = (refs: ReadonlyArray<string>): string => {
	const entries = refs.map((ref) => {
		const literal = sourceLiteral(ref);
		return `\t${literal}: () => import(${literal}),`;
	});
	return `export default {\n${entries.join("\n")}\n};\n`;
};

/**
 * A specifier naming a package, as opposed to a path: the only kind the dependency optimiser takes.
 * A root-relative or relative path — the in-tree fixture's spelling — is source, and Vite serves it
 * transformed like any other file of the app.
 */
const isBareSpecifier = (ref: string): boolean => !ref.startsWith("/") && !ref.startsWith(".");

const moduleRenderersPlugin = (refs: ReadonlyArray<string>) => ({
	name: "tuval-module-renderers",
	resolveId(id: string) {
		return id === MODULE_RENDERERS_ID ? RESOLVED_MODULE_RENDERERS_ID : null;
	},
	load(id: string) {
		return id === RESOLVED_MODULE_RENDERERS_ID ? moduleRenderersSource(refs) : null;
	},
});

interface LaunchResponse {
	setHeader: (name: string, value: string) => void;
	end: (body: string) => void;
}

/** Start the dev server, and close it with the caller's Scope. */
export const servePage = Effect.fn("Tuval.page.serve")(function* (options: PageServerOptions) {
	const {createServer} = yield* attempt(() => import("vite"));
	// Configured here rather than in a `vite.config.ts` so the one config lives in code the
	// typechecker reads. React Fast Refresh is what makes editing a renderer bearable.
	const react = yield* attempt(() => import("@vitejs/plugin-react"));
	const launchEndpoint = {
		name: "tuval-launch-url",
		configureServer(dev: {readonly middlewares: {use: (path: string, handler: never) => void}}) {
			dev.middlewares.use(LAUNCH_ENDPOINT, ((_request: unknown, response: LaunchResponse) => {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({url: options.transport.launchUrl}));
			}) as never);
		},
	};
	const moduleRenderers = options.moduleRenderers ?? [];
	const server = yield* Effect.acquireRelease(
		attempt(() =>
			createServer({
				root: options.root,
				configFile: false,
				appType: "spa",
				plugins: [launchEndpoint, moduleRenderersPlugin(moduleRenderers), react.default()],
				server: {port: options.port, strictPort: false, host: "127.0.0.1"},
				// Named up front so a renderer package is prebundled with the page's own React rather
				// than discovered on first open, which would serve it a second React copy until the
				// re-optimise reload — the one way a module renderer's hooks can break at first paint.
				optimizeDeps: {include: moduleRenderers.filter(isBareSpecifier)},
				// A renderer package names React and Effect as peers, and a peer means "the page's copy".
				// A package linked from another checkout (`link:`, `pnpm link`) carries its own
				// `node_modules`, and without this the browser gets a second React whose hooks throw
				// `Cannot read properties of null (reading 'useState')` on the module window's first paint.
				resolve: {dedupe: ["react", "react-dom", "effect"]},
			}),
		),
		(dev) => Effect.ignore(attempt(() => dev.close())),
	);
	yield* attempt(() => server.listen());
	// Every specifier the rows named is resolved now, from the same root the loader module's own
	// `import()` resolves from. One that does not resolve refuses the page here, naming itself, rather
	// than surfacing as a failed import in a browser tab (the graph compiler's stance: refuse at boot).
	for (const ref of moduleRenderers) {
		const resolved = yield* attempt(() =>
			server.environments.client.pluginContainer.resolveId(ref, RESOLVED_MODULE_RENDERERS_ID),
		);
		if (resolved === null) {
			yield* Effect.ignore(attempt(() => server.close()));
			return yield* new PageServerFailed({
				cause: new Error(
					`renderer module ${JSON.stringify(ref)} does not resolve from ${options.root}; is the package installed here?`,
				),
			});
		}
	}
	const url = server.resolvedUrls?.local[0];
	if (url === undefined) {
		return yield* new PageServerFailed({cause: new Error("it bound no local address")});
	}
	const port = Number(new URL(url).port);
	if (!Number.isInteger(port) || port === 0) {
		return yield* new PageServerFailed({cause: new Error(`its local URL names no port: ${url}`)});
	}
	// The browser's upgrade carries this server's origin, not the socket's, and a fence built from
	// the socket's port alone refuses it (#7560). Done here so no caller can serve a page and forget.
	options.transport.admitLoopbackPort(port);
	return {url, port} satisfies PageServer;
});
