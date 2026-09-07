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

import {dirname} from "node:path";
import {Effect, Schema} from "effect";
import {featuresDefault, type TuvalFeatures} from "../features.ts";
import type {TransportServer} from "../shell/transport/server.ts";
import type {ModuleRendererRef} from "../shell/window/index.ts";

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
	 * Bind `port` or fail. A caller that was *handed* a port — the render harness allocates one and
	 * builds the origin it will screenshot from it — needs the loud failure: falling back to the next
	 * free port leaves that origin pointing at whatever else answers there, which on a machine running
	 * several worktrees is a green capture of another tree (#7992). A caller that asked for `0` is
	 * unaffected either way, so the default stays the forgiving one for `pnpm dev`.
	 */
	readonly strictPort?: boolean;
	/**
	 * The `kind: "module"` renderer specifiers the booted rows declared (`moduleRendererRefs`,
	 * `../shell/window/renderer.ts`), each beside the config module that declared it (ADR 0359, as
	 * amended by #8262). Absent means none: a proof that serves the page over its own rows names none
	 * and the page loads nothing.
	 */
	readonly moduleRenderers?: ReadonlyArray<ModuleRendererRef>;
	/**
	 * The booted config's feature flags (`../config.ts`), merged and every one resolved to a boolean.
	 * Absent means `featuresDefault` — what a caller serving the page over its own rows rather than a
	 * founder's config wants.
	 */
	readonly features?: TuvalFeatures;
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
 * The page's feature-flag module, generated here from the booted config and imported by
 * `./renderers.tsx` under this one id; `./assets.d.ts` declares its shape. It exists for the reason
 * `MODULE_RENDERERS_ID` does: the flags are merged on the node side, the renderer table is built on
 * the browser side, and a generated module is the wire between them that costs the table no async
 * step — so a chat renderer is built at the operator's flags before the first paint rather than
 * rebuilt after a fetch (#8439).
 */
export const FEATURES_ID = "virtual:tuval/features";
const RESOLVED_FEATURES_ID = `\0${FEATURES_ID}`;

/**
 * The source of the feature-flag module: one boolean per flag, keyed by the flag's name. It walks
 * the resolved flags rather than naming any one of them, so a flag added to `TuvalFeatures` reaches
 * the page with no edit here. Every value is written through `=== true` because this is the
 * *resolved* record: a `false` has to reach the page as `false`, never as an absent key.
 */
export const featuresSource = (features: TuvalFeatures): string => {
	const entries = Object.entries(features).map(
		([flag, on]) => `\t${sourceLiteral(flag)}: ${on === true},`,
	);
	return `export default {\n${entries.join("\n")}\n};\n`;
};

/**
 * The plugin serving that module. Exported because the renderer table imports the specifier
 * unconditionally, so every environment loading the table has to answer it: the dev server below
 * with the founder's flags, and `vitest.config.ts` with `featuresDefault` — the desk a unit test
 * means to render.
 */
export const featuresPlugin = (features: TuvalFeatures = featuresDefault) => {
	const source = featuresSource(features);
	return {
		name: "tuval-features",
		resolveId(id: string) {
			return id === FEATURES_ID ? RESOLVED_FEATURES_ID : null;
		},
		load(id: string) {
			return id === RESOLVED_FEATURES_ID ? source : null;
		},
	};
};

/**
 * A specifier naming a package, as opposed to a path: the only kind the dependency optimiser takes.
 * A root-relative or relative path — the in-tree fixture's spelling — is source, and Vite serves it
 * transformed like any other file of the app.
 */
const isBareSpecifier = (ref: string): boolean => !ref.startsWith("/") && !ref.startsWith(".");

/**
 * A specifier written against the page's own root, the spelling an in-tree module uses
 * (`/src/demo/module-window.tsx`). It names a file of the app rather than a module the founder
 * installed, so its base is the root and stays the root: Vite resolves it exactly as it resolves
 * every other import the app writes, and the plugin below leaves it alone.
 */
const isRootRelative = (ref: string): boolean => ref.startsWith("/");

/**
 * A module reference after resolution. `file` is the module the specifier actually names; `origin`
 * is the config module that declared the row, kept so a later sentence can name it.
 */
export interface ResolvedModuleRenderer {
	/** The specifier as the row wrote it: the key the loader module and the renderer table share. */
	readonly ref: string;
	readonly origin: string;
	/** Absolute path of the module `ref` resolved to. */
	readonly file: string;
}

/**
 * The dependency-optimiser entries a set of resolved references asks for: the absolute file behind
 * every bare specifier. Naming them up front is what prebundles a renderer package with the page's
 * own React and Effect rather than discovering it on first open — the one way a module renderer's
 * hooks can break at first paint — and it is the absolute path, not the bare specifier, because a
 * package installed beside the user's config does not resolve from the app root at all (#8262).
 */
export const optimizedDepEntries = (
	resolved: ReadonlyArray<ResolvedModuleRenderer>,
): ReadonlyArray<string> =>
	resolved.filter((entry) => isBareSpecifier(entry.ref)).map((entry) => entry.file);

/**
 * The directories the file server has to be allowed to read from, beside the workspace Vite already
 * allows: each config module's own directory and each resolved module's, because a program installed
 * beside `<home>/.tuval/tuval.config.ts` is served from outside the app's workspace entirely.
 */
export const servedDirectories = (
	resolved: ReadonlyArray<ResolvedModuleRenderer>,
): ReadonlyArray<string> => [
	...new Set(
		resolved.flatMap((entry) =>
			isRootRelative(entry.ref) ? [] : [dirname(entry.origin), dirname(entry.file)],
		),
	),
];

/**
 * The page's own resolver, told the one thing it cannot work out: which file each specifier the
 * loader module imports actually names. Only the loader module's imports are answered — the same
 * specifier written anywhere else in the app is nobody's business but Vite's.
 */
const moduleRenderersPlugin = (resolved: ReadonlyArray<ResolvedModuleRenderer>) => {
	const files = new Map(
		resolved.filter((entry) => !isRootRelative(entry.ref)).map((entry) => [entry.ref, entry.file]),
	);
	return {
		name: "tuval-module-renderers",
		resolveId(id: string, importer: string | undefined) {
			if (id === MODULE_RENDERERS_ID) return RESOLVED_MODULE_RENDERERS_ID;
			if (importer !== RESOLVED_MODULE_RENDERERS_ID) return null;
			return files.get(id) ?? null;
		},
		load(id: string) {
			return id === RESOLVED_MODULE_RENDERERS_ID
				? moduleRenderersSource(resolved.map((entry) => entry.ref))
				: null;
		},
	};
};

/**
 * Why a specifier refused the page, in the terms of whoever has to act on it: a package the founder
 * installed is named against the config module they wrote the row in, and an in-tree path against
 * the page root it was written for. Neither sentence blames a base the author never named.
 */
const unresolvedSentence = (ref: ModuleRendererRef, root: string): string =>
	isRootRelative(ref.ref)
		? `renderer module ${JSON.stringify(ref.ref)}, declared by ${ref.origin}, does not resolve from the page root ${root}`
		: `renderer module ${JSON.stringify(ref.ref)} does not resolve from ${ref.origin}, the config that declared it; is the package installed beside that config?`;

/**
 * Every reference resolved from the base its own row was declared against, before the page binds
 * anything. Node resolved the row's kernel half from the config module that declared it, and this is
 * the same lookup for the row's window half (#8262) — so a program lives beside the user's config
 * rather than having to be a dependency of the app. A specifier that resolves from neither that
 * config nor the page root refuses here, naming itself and that config, rather than surfacing as a
 * failed import in a browser tab: the graph compiler's stance, refuse before anything is shown.
 *
 * The resolver is a Vite of its own, in middleware mode — it binds no port and serves nothing. It
 * has to be a second one because its answers are what the real server's `optimizeDeps.include` and
 * `server.fs.allow` are built from, and a server reads both once, when it is created.
 */
const resolveModuleRenderers = Effect.fn("Tuval.page.resolveModuleRenderers")(function* (
	createServer: typeof import("vite").createServer,
	root: string,
	refs: ReadonlyArray<ModuleRendererRef>,
) {
	if (refs.length === 0) return [] as ReadonlyArray<ResolvedModuleRenderer>;
	const resolver = yield* attempt(() =>
		createServer({
			root,
			configFile: false,
			appType: "custom",
			server: {middlewareMode: true, hmr: false, ws: false},
			// Nothing is served from this one, so nothing needs prebundling; discovery here would
			// optimise into a cache the real server is about to rebuild anyway.
			optimizeDeps: {noDiscovery: true, include: []},
		}),
	);
	return yield* Effect.forEach(
		refs,
		(ref) =>
			Effect.gen(function* () {
				// The importer is the base: the config module for a package or a relative path, and none at
				// all for the root-relative spelling, which Vite reads against the root it was given.
				const importer = isRootRelative(ref.ref) ? undefined : ref.origin;
				const hit = yield* attempt(() =>
					resolver.environments.ssr.pluginContainer.resolveId(ref.ref, importer),
				);
				if (hit === null) {
					return yield* new PageServerFailed({cause: new Error(unresolvedSentence(ref, root))});
				}
				return {ref: ref.ref, origin: ref.origin, file: hit.id} satisfies ResolvedModuleRenderer;
			}),
		// Serial on purpose: the first specifier that does not resolve is the one the founder is
		// told about, and row order is the order they wrote.
		{concurrency: 1},
	).pipe(Effect.ensuring(Effect.ignore(attempt(() => resolver.close()))));
});

interface LaunchResponse {
	setHeader: (name: string, value: string) => void;
	end: (body: string) => void;
}

/** Start the dev server, and close it with the caller's Scope. */
export const servePage = Effect.fn("Tuval.page.serve")(function* (options: PageServerOptions) {
	const {createServer, searchForWorkspaceRoot} = yield* attempt(() => import("vite"));
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
	// Resolved before the server exists, because the answers are what its optimiser entries and its
	// file-serving allowance are built from — and because a specifier that resolves from nowhere then
	// refuses with no port bound and nothing to close.
	const moduleRenderers = yield* resolveModuleRenderers(
		createServer,
		options.root,
		options.moduleRenderers ?? [],
	);
	const server = yield* Effect.acquireRelease(
		attempt(() =>
			createServer({
				root: options.root,
				configFile: false,
				appType: "spa",
				plugins: [
					launchEndpoint,
					moduleRenderersPlugin(moduleRenderers),
					featuresPlugin(options.features),
					react.default(),
				],
				server: {
					port: options.port,
					strictPort: options.strictPort ?? false,
					host: "127.0.0.1",
					// A program installed beside the user's config is outside the app's workspace, and
					// Vite's default allowance is that workspace alone — so the page would resolve the
					// module and then refuse to serve it. The workspace stays in the list: the app's own
					// linked packages are served from it.
					fs: {
						allow: [searchForWorkspaceRoot(options.root), ...servedDirectories(moduleRenderers)],
					},
				},
				// Named up front so a renderer package is prebundled with the page's own React rather
				// than discovered on first open, which would serve it a second React copy until the
				// re-optimise reload — the one way a module renderer's hooks can break at first paint.
				optimizeDeps: {include: [...optimizedDepEntries(moduleRenderers)]},
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
