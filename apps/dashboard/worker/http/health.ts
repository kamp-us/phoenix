/**
 * The liveness probe — `GET /api/health` (ADR 0027,
 * `.patterns/worker-http-transport-layout.md`). The lone typed-JSON `HttpApi`
 * group; returns `{status, environment}`. The handler reads the deploy
 * environment via `yield* AppConfig`, so the route's only upstream requirement is
 * the `ConfigProvider` alchemy auto-wires at worker scope.
 */
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
import {AppConfig} from "../config.ts";

export class HealthStatus extends Schema.Class<HealthStatus>("@kampus/dashboard/HealthStatus")({
	status: Schema.String,
	environment: Schema.NullOr(Schema.String),
}) {}

const health = HttpApiEndpoint.get("health", "/api/health", {success: HealthStatus});

export class HealthGroup extends HttpApiGroup.make("health").add(health) {}

export class HealthApi extends HttpApi.make("dashboard").add(HealthGroup) {}

const healthGroup = HttpApiBuilder.group(HealthApi, "health", (h) =>
	h.handle("health", () =>
		Effect.gen(function* () {
			// `orDie`: a `ConfigError` (value outside the two literals) means a
			// malformed env; die rather than widen the handler's error channel.
			const {environment} = yield* AppConfig.pipe(Effect.orDie);
			return new HealthStatus({
				status: "ok",
				environment,
			});
		}),
	),
);

/**
 * Platform stubs `HttpApiBuilder.layer` requires. Workers serve no files (the SPA
 * comes from the `assets` binding), so the file-serving paths die if hit — safe,
 * since the typed-JSON endpoint never produces a file response.
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
 * The health route as a single router layer. The handler's `ConfigProvider`
 * requirement is discharged at the app boundary at worker scope (alchemy
 * auto-wires it, see `app.ts`); this layer only wires the group + platform stubs.
 */
export const healthApiLayer = HttpApiBuilder.layer(HealthApi).pipe(
	Layer.provide(healthGroup),
	Layer.provide(platformStubs),
);
