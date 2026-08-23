/**
 * Branded ID schemas — the shared home for nominal id types. Two ids that are both `string`
 * at runtime are indistinguishable to the type checker, so an argument swap compiles (#2712).
 * `Schema.brand` makes them distinct types while staying plain strings at runtime: the brand
 * is type-only, so wire and D1 bytes are byte-identical.
 *
 * Idiom grounded in Effect-TS/effect `SCHEMA.md` §Branding.
 */
import * as Schema from "effect/Schema";

// Type-only: adds no runtime check or transform (Effect-TS/effect `SCHEMA.md` §Branding).
export const brandedId = <const B extends string>(brand: B) =>
	Schema.String.pipe(Schema.brand(brand));

// Minted from the session string at each write boundary via `UserId.make(user.id)`.
export const UserId = brandedId("UserId");
export type UserId = typeof UserId.Type;

export const DefinitionId = brandedId("DefinitionId");
export type DefinitionId = typeof DefinitionId.Type;

// A sözlük term (başlık) slug.
export const TermSlug = brandedId("TermSlug");
export type TermSlug = typeof TermSlug.Type;

// Polymorphic over the `TargetKind` set: one broad brand tags the raw id and the
// accompanying `targetKind` carries the discriminator. The brand only stops a `TargetId`
// being confused with a `UserId`, not one target kind for another — that is `TargetKind`'s job.
export const TargetId = brandedId("TargetId");
export type TargetId = typeof TargetId.Type;
