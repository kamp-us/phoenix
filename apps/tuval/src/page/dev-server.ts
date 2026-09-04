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
 */

import {Effect, Schema} from "effect";

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
	/** The transport URL, token and all. Answered to the page and written nowhere else. */
	readonly launchUrl: string;
	/** `0` picks a free port, which is what a second `pnpm dev` on one machine needs. */
	readonly port: number;
}

export interface PageServer {
	/** What the founder opens. */
	readonly url: string;
}

export const LAUNCH_ENDPOINT = "/__tuval/launch";

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
				response.end(JSON.stringify({url: options.launchUrl}));
			}) as never);
		},
	};
	const server = yield* Effect.acquireRelease(
		attempt(() =>
			createServer({
				root: options.root,
				configFile: false,
				appType: "spa",
				plugins: [launchEndpoint, react.default()],
				server: {port: options.port, strictPort: false, host: "127.0.0.1"},
			}),
		),
		(dev) => Effect.ignore(attempt(() => dev.close())),
	);
	yield* attempt(() => server.listen());
	const url = server.resolvedUrls?.local[0];
	if (url === undefined) {
		return yield* new PageServerFailed({cause: new Error("it bound no local address")});
	}
	return {url} satisfies PageServer;
});
