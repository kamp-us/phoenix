/**
 * Handlers for the typed-JSON API (`admin-api.ts`) — the health probe and the
 * dev-only admin seeders (ADR 0027, `.patterns/alchemy-http-router.md`).
 *
 * Each `HttpApiBuilder.group` implements one group's endpoints against the
 * worker-level services. The admin seeders are the "admin layer set" of the
 * request/admin split (ADR 0012): they require `AdminAuth.required` (env-gated)
 * and the per-feature `…Admin` services — all worker-level singletons built in
 * the worker init over the same `Drizzle`. A denied call maps the domain
 * `AdminForbidden` to the wire `Forbidden` (403).
 *
 * `adminApiLayer` composes the groups and provides the platform stubs
 * `HttpApiBuilder.layer` needs (Workers have no `FileSystem`). The group
 * handlers' domain requirements (`AdminAuth`, `SozlukAdmin`, `PanoAdmin`,
 * `PasaportAdmin`) surface as route markers and are discharged at the app
 * boundary with `HttpRouter.provideRequest` (`app.ts`); `WorkerEnvironment`
 * (health) is satisfied at worker scope.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {PanoAdmin} from "../features/pano/PanoAdmin.ts";
import {PasaportAdmin} from "../features/pasaport/PasaportAdmin.ts";
import {SozlukAdmin} from "../features/sozluk/SozlukAdmin.ts";
import {AdminAuth} from "../services/index.ts";
import {
	AppApi,
	BackfillProfilesResult,
	ClearTermsResult,
	Forbidden,
	HealthStatus,
	SeedPostsResult,
	UpsertTermResult,
} from "./admin-api.ts";

/**
 * Map the domain `AdminForbidden` (raised by `AdminAuth.required`) to the wire
 * `Forbidden` error so the HTTP layer returns 403. Shared by every seeder
 * handler — they all gate the same way.
 */
const requireAdmin = AdminAuth.required.pipe(
	Effect.catchTag("@phoenix/AdminAuth/Forbidden", (e) =>
		Effect.fail(new Forbidden({reason: e.reason})),
	),
);

/**
 * A failed `Drizzle` query in a seeder is an unexpected infra failure, not a
 * client error — die on it (→ 500) so the only typed wire failure these
 * handlers carry is `Forbidden` (the env gate). Mirrors the old Hono routes,
 * which let a thrown query bubble to a 500. Applied to each handler with
 * `Effect.catchTag("@phoenix/Drizzle/Error", Effect.die)`.
 */

const healthGroup = HttpApiBuilder.group(AppApi, "health", (h) =>
	h.handle("health", () =>
		Effect.gen(function* () {
			const env = yield* Cloudflare.WorkerEnvironment;
			const environment = (env as Record<string, unknown>).ENVIRONMENT;
			return new HealthStatus({
				status: "ok",
				environment: typeof environment === "string" ? environment : null,
			});
		}),
	),
);

const sozlukGroup = HttpApiBuilder.group(AppApi, "sozluk", (h) =>
	h
		.handle("upsertTerm", ({payload}) =>
			Effect.gen(function* () {
				yield* requireAdmin;
				const admin = yield* SozlukAdmin;
				const result = yield* admin.seedTerm({
					slug: payload.slug,
					title: payload.title,
					definitions: payload.definitions.map((d) => ({
						authorId: d.authorId,
						authorName: d.authorName,
						body: d.body,
						...(d.score !== undefined ? {score: d.score} : {}),
					})),
				});
				return new UpsertTermResult({slug: payload.slug, ...result});
			}).pipe(Effect.catchTag("@phoenix/Drizzle/Error", Effect.die)),
		)
		.handle("clearTerms", ({payload}) =>
			Effect.gen(function* () {
				yield* requireAdmin;
				const admin = yield* SozlukAdmin;
				const result = yield* admin.clearAllTerms([...(payload.slugs ?? [])]);
				return new ClearTermsResult(result);
			}).pipe(Effect.catchTag("@phoenix/Drizzle/Error", Effect.die)),
		),
);

const panoGroup = HttpApiBuilder.group(AppApi, "pano", (h) =>
	h.handle("seedPosts", ({payload}) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const admin = yield* PanoAdmin;
			const result = yield* admin.seedPosts({
				...(payload.clear !== undefined ? {clear: payload.clear} : {}),
			});
			return new SeedPostsResult({...result, postIds: [...result.postIds]});
		}).pipe(Effect.catchTag("@phoenix/Drizzle/Error", Effect.die)),
	),
);

const pasaportGroup = HttpApiBuilder.group(AppApi, "pasaport", (h) =>
	h.handle("backfillProfiles", () =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const admin = yield* PasaportAdmin;
			const result = yield* admin.backfillProfiles;
			return new BackfillProfilesResult(result);
		}).pipe(Effect.catchTag("@phoenix/Drizzle/Error", Effect.die)),
	),
);

/**
 * Platform stubs `HttpApiBuilder.layer` requires (`HttpPlatform`, `FileSystem`,
 * `Path`, `Etag.Generator`). Workers serve no files — the SPA comes from the
 * `assets` binding, not a route — so the file-serving paths die if ever hit. The
 * typed-JSON endpoints never produce a file response, so the stub is safe.
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
 * The typed-JSON routes as a single router layer — health + the admin seeders.
 *
 * The group handlers' domain requirements (`AdminAuth`, `SozlukAdmin`,
 * `PanoAdmin`, `PasaportAdmin`) and `WorkerEnvironment` (health) surface as
 * `Request<"Requires">` markers once the groups register their routes; those
 * are discharged at the app boundary with `HttpRouter.provideRequest` (see
 * `app.ts`), not `Layer.provide`. This layer only wires the group definitions
 * and the platform stubs `HttpApiBuilder.layer` needs.
 */
export const adminApiLayer = HttpApiBuilder.layer(AppApi).pipe(
	Layer.provide([healthGroup, sozlukGroup, panoGroup, pasaportGroup]),
	Layer.provide(platformStubs),
);

/** The env-gated `AdminAuth` value layer the app discharges via `provideRequest`. */
export const adminAuthLayer = (allowed: boolean) => Layer.succeed(AdminAuth, {allowed});
