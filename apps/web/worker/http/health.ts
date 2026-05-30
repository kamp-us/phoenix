/**
 * The liveness probe — `GET /api/health` (ADR 0027,
 * `.patterns/alchemy-http-router.md`).
 *
 * A single typed-JSON `HttpApi` group: the only endpoint phoenix exposes with a
 * real response schema that isn't a raw-`Request` route. Returns `{status,
 * environment}` so an uptime check can confirm the worker is live and read which
 * deploy environment answered.
 *
 * The handler reads the deploy environment off the upstream
 * `Cloudflare.WorkerEnvironment` Tag (alchemy provides it at worker scope), so
 * `WorkerEnvironment` surfaces as a route marker discharged at the app boundary
 * with `HttpRouter.provideRequest` (`app.ts`) — satisfied at worker scope.
 *
 * `healthApiLayer` provides the platform stubs `HttpApiBuilder.layer` needs
 * (Workers have no `FileSystem`); the typed-JSON endpoint never produces a file
 * response, so the stubs are safe.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

export class HealthStatus extends Schema.Class<HealthStatus>("@phoenix/HealthStatus")({
	status: Schema.String,
	environment: Schema.NullOr(Schema.String),
}) {}

const health = HttpApiEndpoint.get("health", "/api/health", {success: HealthStatus});

export class HealthGroup extends HttpApiGroup.make("health").add(health) {}

/** The single typed-JSON API: the liveness probe. Implemented below. */
export class HealthApi extends HttpApi.make("phoenix").add(HealthGroup) {}

const healthGroup = HttpApiBuilder.group(HealthApi, "health", (h) =>
	h.handle("health", () =>
		Effect.gen(function* () {
			// Read the deploy environment off the upstream `Cloudflare.WorkerEnvironment`
			// Tag (alchemy provides it at worker scope). The `ENVIRONMENT` field is
			// declared on the worker's `env` block (`index.ts`); coerce to string at
			// the boundary since `WorkerEnvironment` is an untyped record.
			const env = yield* Cloudflare.WorkerEnvironment;
			return new HealthStatus({
				status: "ok",
				environment: String((env as {ENVIRONMENT?: unknown}).ENVIRONMENT ?? ""),
			});
		}),
	),
);

/**
 * Platform stubs `HttpApiBuilder.layer` requires (`HttpPlatform`, `FileSystem`,
 * `Path`, `Etag.Generator`). Workers serve no files — the SPA comes from the
 * `assets` binding, not a route — so the file-serving paths die if ever hit. The
 * typed-JSON endpoint never produces a file response, so the stub is safe.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
	fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported in Workers"),
	fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported in Workers"),
});

const platformStubs = Layer.mergeAll(
	Etag.layer,
	HttpPlatformStub,
	Path.layer,
	FileSystem.layerNoop({}),
);

/**
 * The health route as a single router layer. The handler's `WorkerEnvironment`
 * requirement surfaces as a `Request<"Requires">` marker once the group
 * registers its route; it's discharged at the app boundary at worker scope (see
 * `app.ts`). This layer only wires the group definition and the platform stubs
 * `HttpApiBuilder.layer` needs.
 */
export const healthApiLayer = HttpApiBuilder.layer(HealthApi).pipe(
	Layer.provide(healthGroup),
	Layer.provide(platformStubs),
);
