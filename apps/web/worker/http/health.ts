/**
 * The readiness probe — `GET /api/health` (ADR 0027, `.patterns/alchemy-http-router.md`), the
 * only typed-JSON `HttpApi` group. Both outcomes are typed (ADR 0156): 200 `HealthStatus`, or
 * 503 `HealthDegraded` when a `FlagshipError` proves the binding unreachable. A `ConfigError`
 * (malformed env) stays `orDie`→500 — that IS a real defect.
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
import {Flagship} from "../features/flagship/Flagship.ts";

export class HealthStatus extends Schema.Class<HealthStatus>("@kampus/HealthStatus")({
	status: Schema.String,
	environment: Schema.NullOr(Schema.String),
	// Asserts reachability of the binding, NOT the value of any feature flag. Named
	// `flagshipReachable` (not `…Bound`) so an operator can't misread `false` as
	// "missing/unhealthy" (#864); that reading is its own typed body, `HealthDegraded`.
	flagshipReachable: Schema.Boolean,
}) {}

/**
 * The typed not-ready-but-alive body (ADR 0156). Both fields are `Literal`, so a degraded body
 * can never claim `"ok"`. `httpApiStatus: 503` is what the framework encodes the response as
 * (`HttpApiSchema.getStatusError` reads it; an unannotated error is 500).
 */
export class HealthDegraded extends Schema.TaggedErrorClass<HealthDegraded>()(
	"@kampus/HealthDegraded",
	{
		status: Schema.Literal("degraded"),
		environment: Schema.NullOr(Schema.String),
		flagshipReachable: Schema.Literal(false),
	},
	{httpApiStatus: 503},
) {}

const health = HttpApiEndpoint.get("health", "/api/health", {
	success: HealthStatus,
	error: HealthDegraded,
});

export class HealthGroup extends HttpApiGroup.make("health").add(health) {}

export class HealthApi extends HttpApi.make("phoenix").add(HealthGroup) {}

const healthGroup = HttpApiBuilder.group(HealthApi, "health", (h) =>
	h.handle("health", () =>
		Effect.gen(function* () {
			// `orDie`: a `ConfigError` means a malformed env — a real handler defect, kept at 500.
			const {environment} = yield* AppConfig.pipe(Effect.orDie);
			// The read completing at all proves the `FlagshipClient` resolved end-to-end, so the probe
			// asserts reachability, not the flag's value. Evaluation never throws (it falls back to the
			// default), so an unreachable binding surfaces only on `FlagshipError` — caught to the typed
			// 503 rather than `orDie`→500, because flags fail closed (ADR 0156).
			const flagship = yield* Flagship;
			return yield* flagship.getBooleanValue("phoenix-health-probe", false).pipe(
				Effect.as(
					new HealthStatus({
						status: "ok",
						environment,
						flagshipReachable: true,
					}),
				),
				Effect.catchTag(
					"FlagshipError",
					() =>
						new HealthDegraded({
							status: "degraded",
							environment,
							flagshipReachable: false,
						}),
				),
			);
		}),
	),
);

// Workers serve no files (the SPA comes from the `assets` binding), so the file-serving paths
// die if hit — safe, since the typed-JSON endpoint never produces a file response.
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

// The handler's `ConfigProvider` requirement is discharged at the app boundary at worker scope
// (alchemy auto-wires it, see `app.ts`); this layer only wires the group + platform stubs.
export const healthApiLayer = HttpApiBuilder.layer(HealthApi).pipe(
	Layer.provide(healthGroup),
	Layer.provide(platformStubs),
);
