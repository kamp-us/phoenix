/**
 * The typed JSON HTTP surface — `HttpApi` specs for the liveness probe and the
 * dev-only admin seeders (ADR 0027, `.patterns/alchemy-http-router.md`).
 *
 * These are the endpoints with a real request/response schema, so they're
 * declared as `HttpApi` groups: payloads decode through `Schema`, responses
 * encode through `Schema`, and the handler (see `admin-handlers.ts`) receives
 * already-validated input. The raw-`Request` endpoints (`POST /fate`,
 * `/api/auth/*`) stay imperative `HttpRouter.add` routes — they want the raw
 * `Request`, not a schema.
 *
 * The admin seeders back the `pnpm sozluk:import` / `pnpm pano:import` scripts;
 * their response shapes match what those scripts read off the JSON body
 * (`import-sozluk.ts`, `import-pano.ts`). They're gated by `AdminAuth` in the
 * handler (env === "development"); a denied call surfaces as `AdminForbidden`
 * (403).
 */
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/* -------------------------------------------------------------------------- */
/* Shared error                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The wire error for an admin operation attempted outside an allowed
 * environment — maps the domain `AdminForbidden` (env gate) to a 403. Every
 * admin endpoint declares it so the gate is expressible in the typed surface.
 */
export class Forbidden extends Schema.ErrorClass<Forbidden>("@phoenix/admin/Forbidden")({
	reason: Schema.String,
}) {}

/** `Forbidden` carrying the 403 status the HTTP layer reads off the error AST. */
const ForbiddenError = Forbidden.pipe(HttpApiSchema.status(403));

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

export class HealthStatus extends Schema.Class<HealthStatus>("@phoenix/HealthStatus")({
	status: Schema.String,
	environment: Schema.NullOr(Schema.String),
}) {}

const health = HttpApiEndpoint.get("health", "/api/health", {success: HealthStatus});

export class HealthGroup extends HttpApiGroup.make("health").add(health) {}

/* -------------------------------------------------------------------------- */
/* Sozluk seeders                                                              */
/* -------------------------------------------------------------------------- */

const SeedDefinition = Schema.Struct({
	authorId: Schema.String,
	authorName: Schema.String,
	body: Schema.String,
	score: Schema.optional(Schema.Number),
});

const UpsertTermPayload = Schema.Struct({
	slug: Schema.String,
	title: Schema.String,
	definitions: Schema.Array(SeedDefinition),
});

export class UpsertTermResult extends Schema.Class<UpsertTermResult>("@phoenix/UpsertTermResult")({
	slug: Schema.String,
	created: Schema.Boolean,
	insertedDefinitions: Schema.Number,
	skippedDefinitions: Schema.Number,
}) {}

const upsertTerm = HttpApiEndpoint.post("upsertTerm", "/api/admin/sozluk/upsert-term", {
	payload: UpsertTermPayload,
	success: UpsertTermResult,
	error: ForbiddenError,
});

const ClearTermsPayload = Schema.Struct({
	slugs: Schema.optional(Schema.Array(Schema.String)),
});

export class ClearTermsResult extends Schema.Class<ClearTermsResult>("@phoenix/ClearTermsResult")({
	terms: Schema.Number,
	definitions: Schema.Number,
}) {}

const clearTerms = HttpApiEndpoint.post("clearTerms", "/api/admin/sozluk/clear", {
	payload: ClearTermsPayload,
	success: ClearTermsResult,
	error: ForbiddenError,
});

export class SozlukAdminGroup extends HttpApiGroup.make("sozluk").add(upsertTerm).add(clearTerms) {}

/* -------------------------------------------------------------------------- */
/* Pano seeder                                                                 */
/* -------------------------------------------------------------------------- */

const SeedPostsPayload = Schema.Struct({
	clear: Schema.optional(Schema.Boolean),
});

export class SeedPostsResult extends Schema.Class<SeedPostsResult>("@phoenix/SeedPostsResult")({
	inserted: Schema.Number,
	postIds: Schema.Array(Schema.String),
	cleared: Schema.Struct({posts: Schema.Number, comments: Schema.Number}),
}) {}

const seedPosts = HttpApiEndpoint.post("seedPosts", "/api/admin/pano/seed", {
	payload: SeedPostsPayload,
	success: SeedPostsResult,
	error: ForbiddenError,
});

export class PanoAdminGroup extends HttpApiGroup.make("pano").add(seedPosts) {}

/* -------------------------------------------------------------------------- */
/* Pasaport seeder                                                             */
/* -------------------------------------------------------------------------- */

export class BackfillProfilesResult extends Schema.Class<BackfillProfilesResult>(
	"@phoenix/BackfillProfilesResult",
)({
	emitted: Schema.Number,
}) {}

const backfillProfiles = HttpApiEndpoint.post(
	"backfillProfiles",
	"/api/admin/pasaport/backfill-profiles",
	{success: BackfillProfilesResult, error: ForbiddenError},
);

export class PasaportAdminGroup extends HttpApiGroup.make("pasaport").add(backfillProfiles) {}

/* -------------------------------------------------------------------------- */
/* The API                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The single typed-JSON API: the health probe plus the four dev-only admin
 * seeder groups. Implemented in `admin-handlers.ts`; mounted into `AppLive`
 * (`app.ts`) alongside the imperative raw-`Request` routes.
 */
export class AppApi extends HttpApi.make("phoenix")
	.add(HealthGroup)
	.add(SozlukAdminGroup)
	.add(PanoAdminGroup)
	.add(PasaportAdminGroup) {}
