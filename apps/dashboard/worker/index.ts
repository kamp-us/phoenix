/**
 * The dashboard worker, on alchemy-effect (ADR 0026–0031, 0056). Its OWN worker
 * on its OWN stack (`alchemy.run.ts`) — a second, independent Cloudflare Worker,
 * not part of apps/web (ADR 0056).
 *
 * Modular `.make()` form (ADR 0028): the `Dashboard` class is the worker Tag
 * (declaring the hosted `PipelineCacheDO` as its `Deps`), `Dashboard.make(body)`
 * is the implementation Layer. The body runs in two phases: init builds the
 * per-isolate `Pipeline` service once (its GitHub client + token read, plus the
 * `PipelineCache` over the hosted DO); runtime returns the `fetch` handler.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {environment, githubToken} from "./config.ts";
import {type PipelineCacheDO, PipelineCacheDOLive} from "./features/pipeline/cache-do.ts";
import {GithubClientLive} from "./features/pipeline/github.ts";
import {Pipeline, PipelineLive} from "./features/pipeline/Pipeline.ts";
import {PipelineCacheLive} from "./features/pipeline/PipelineCache.ts";
import {makeAppLive} from "./http/app.ts";

export class Dashboard extends Cloudflare.Worker<
	Dashboard,
	// `{}` is alchemy's empty-RPC-shape sentinel (this worker exposes only
	// `fetch`); biome bans bare `{}`, but no other type expresses "no extra shape"
	// without forcing keys to `never`, which `{fetch}` then fails to satisfy.
	// biome-ignore lint/complexity/noBannedTypes: alchemy's empty-RPC-shape sentinel
	{},
	// The TTL cache substrate (#254), declared as the worker's `Deps` (ADR 0028) so
	// init can `yield*` the Tag and provide its `.make()` Layer below.
	PipelineCacheDO
>()("dashboard", {
	main: import.meta.filename,
	// Env bindings, per-key from the `effect/Config` constants in `config.ts`:
	// `ENVIRONMENT` → `plain_text`, `GITHUB_TOKEN` → `secret_text`. Alchemy resolves
	// each at deploy and runtime reads the same value off the auto-wired
	// ConfigProvider.
	env: {ENVIRONMENT: environment, GITHUB_TOKEN: githubToken},
	assets: {
		// The built SPA shell (`vite build` emits `dist/client`, ADR 0030; path is
		// relative to the alchemy CLI's `apps/dashboard` cwd). At the edge the worker
		// serves it; the `runWorkerFirst` globs keep the worker-owned paths from
		// being shadowed by the SPA shell (a missing entry returns the shell for GET
		// and 405 for POST).
		directory: "./dist/client",
		notFoundHandling: "single-page-application",
		runWorkerFirst: ["/api/*"],
	},
	compatibility: {flags: ["nodejs_compat"]},
	observability: {enabled: true},
}) {}

export default Dashboard.make(
	Effect.gen(function* () {
		// ── INIT PHASE (deploy time + once per isolate) ──
		// Resolve the `Pipeline` service ONCE — its `GithubClient` reads the
		// `GITHUB_TOKEN` binding, and its `PipelineCache` fronts the GitHub fetch
		// over the hosted `PipelineCacheDO` (#254). Wrapping the resolved value
		// dependency-free (`R = never`) keeps `provideRequest` from reconstructing
		// the client per request (ADR 0041). `PipelineCacheDOLive` registers the DO
		// and resolves its Tag (a single instance, no self-addressing — `R = never`).
		const pipeline = yield* Pipeline.pipe(
			Effect.provide(
				PipelineLive.pipe(
					Layer.provide(GithubClientLive),
					Layer.provide(PipelineCacheLive),
					Layer.provide(PipelineCacheDOLive),
				),
			),
		);
		const pipelineLayer = Layer.succeed(Pipeline)(pipeline);

		// ── RUNTIME PHASE ── return the compiled `fetch`.
		return {fetch: makeAppLive({pipelineLayer}).pipe(HttpRouter.toHttpEffect)};
	}),
);
