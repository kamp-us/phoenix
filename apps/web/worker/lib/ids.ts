/**
 * Branded ID schemas — the shared home for nominal id types (epic #2700).
 *
 * Two ids that are both `string` at runtime (a user id, a definition id) are
 * indistinguishable to the type checker, so an argument swap like
 * `voteDefinition({definitionId, voterId})` compiles even when the two are
 * transposed (#2712). `Schema.brand` fixes that: it intersects a schema's
 * output type with a nominal `Brand`, so `UserId` and `DefinitionId` become
 * distinct types that can't be passed for one another — while staying plain
 * strings at runtime (the brand is type-only: `.make`/decode return the input
 * unchanged, so wire and D1 bytes are byte-identical).
 *
 * Idiom grounded in effect-smol `SCHEMA.md` §Branding — the top-level
 * `Schema.String.pipe(Schema.brand("UserId"))` form (not a hand-rolled phantom
 * symbol) — and `Brand.ts`. Feature-local ids (sözlük's DefinitionId, TermSlug)
 * live here beside the cross-feature UserId so every Phase-2 child of #2700
 * imports one module.
 */
import * as Schema from "effect/Schema";

/**
 * Mint a branded id schema: a bare string nominally tagged `B`. Type-only — it
 * adds no runtime check or transform (per effect-smol `SCHEMA.md` §Branding,
 * `brand` narrows the output type without validating). This is the API Phase-2
 * children call to declare their own feature ids.
 */
export const brandedId = <const B extends string>(brand: B) =>
	Schema.String.pipe(Schema.brand(brand));

/**
 * The authenticated user's id (`CurrentUser.user.id`) — cross-feature, threaded
 * as every write's actor/author/voter/reactor argument. Minted from the session
 * string at each write boundary via `UserId.make(user.id)`.
 */
export const UserId = brandedId("UserId");
export type UserId = typeof UserId.Type;

/** A sözlük definition (entry) id. */
export const DefinitionId = brandedId("DefinitionId");
export type DefinitionId = typeof DefinitionId.Type;

/** A sözlük term (başlık) slug — the başlık's stable identifier. */
export const TermSlug = brandedId("TermSlug");
export type TermSlug = typeof TermSlug.Type;
