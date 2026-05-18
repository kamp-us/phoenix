/**
 * Round-trip codec between worker-side error values and the wire-format
 * `extensions.code` strings the SPA matches on.
 *
 * Encode side (worker): given any failure surfaced from a resolver, produce a
 * `GraphQLError` with a stable `extensions.code`. The Effect `resolver()`
 * wrapper invokes this in its catch path so mutation resolvers no longer carry
 * inline `try { ... } catch { throw mapXMutationError(err) }` boilerplate.
 *
 * Decode side (SPA): given a wire-format code string, return the same string
 * narrowed to {@link MutationErrorCode} when known, or `null` otherwise. The
 * SPA can `switch` on the typed value instead of stringly-comparing against
 * `"UNAUTHORIZED"` etc.
 *
 * Matching strategy
 * -----------------
 * The encoder switches on **`_tag`** first — that's the contract for every
 * `Data.TaggedError` raised by an Effect service (`Sozluk`, `Pano`, `Vote`,
 * `Pasaport`, `Drizzle`, `Auth`). Tagged errors are the long-term shape.
 *
 * For the in-flight migration window (until tasks 2–5 of the effect-migration
 * land), the legacy class-named errors raised by `worker/features/<feature>/module.ts`
 * still flow through here. Those errors expose `name` + optional `code` but no
 * `_tag`, so the encoder falls through to a `name`-based switch that produces
 * the same wire codes the original `instanceof`-style encoder did. Both shapes
 * survive the workerd RPC boundary identically (class identity is lost but
 * `name` / `code` / `_tag` are preserved as plain fields).
 *
 * As each feature service migrates to `Data.TaggedError`, its tags get a case
 * in the `_tag` switch and the corresponding `name` case in the legacy switch
 * disappears. When the last `module.ts` is deleted, the legacy switch goes
 * with it.
 */
import {GraphQLError} from "graphql";

// The wire-side constant + decoder live in `src/lib/` so the SPA can import
// them without crossing the worker boundary; re-exported here so worker
// callers don't need to know where the contract is physically defined.
export {
	decodeMutationErrorCode,
	MUTATION_ERROR_CODES,
	type MutationErrorCode,
} from "../../src/lib/mutationErrorCodes";

function gqlError(message: string, code: string): GraphQLError {
	return new GraphQLError(message, {extensions: {code}});
}

/**
 * Map any thrown / failed value from inside a resolver onto a `GraphQLError`
 * with a stable wire-format `extensions.code`. Idempotent on already-encoded
 * `GraphQLError` inputs.
 */
export function encodeMutationError(err: unknown): GraphQLError {
	if (err instanceof GraphQLError) return err;

	const e = err as (Error & {code?: string; _tag?: string}) | null | undefined;
	const tag = e?._tag;

	// ── Tagged-error path (the long-term shape) ────────────────────────────
	// Every `Data.TaggedError` defined under `worker/services/*` and the
	// per-feature `errors.ts` files routes through here. New tags land in this
	// switch — keep them sorted by namespace for easy diffing.
	if (typeof tag === "string") {
		switch (tag) {
			case "Unauthorized":
				return gqlError("not authorized", "UNAUTHORIZED");

			case "@phoenix/AdminAuth/Forbidden":
				return gqlError("admin operations forbidden", "UNAUTHORIZED");

			case "@phoenix/Drizzle/Error":
				return gqlError("internal error", "INTERNAL_SERVER_ERROR");
		}
	}

	// ── Legacy class-name path (in-flight migration) ──────────────────────
	// The `module.ts` files still raise plain `Error` subclasses with a `name`
	// field. Until each feature ports to `Data.TaggedError` in tasks 2–5,
	// match on `name` and produce identical wire codes to the pre-rewrite
	// encoder.
	const name = e?.name;
	switch (name) {
		case "UnauthorizedDefinitionMutationError":
		case "UnauthorizedPostMutationError":
		case "UnauthorizedCommentMutationError":
			return gqlError("not authorized", "UNAUTHORIZED");

		case "DefinitionNotFoundError":
			return gqlError(e?.message ?? "definition not found", "DEFINITION_NOT_FOUND");

		case "PostNotFoundError":
			return gqlError(e?.message ?? "post not found", "POST_NOT_FOUND");

		case "CommentNotFoundError":
			return gqlError(e?.message ?? "comment not found", "COMMENT_NOT_FOUND");

		case "UsernameValidationError":
		case "DefinitionValidationError":
		case "PostValidationError":
		case "CommentValidationError": {
			const code = e?.code ? e.code.toUpperCase() : "BAD_REQUEST";
			return gqlError(e?.message ?? "validation failed", code);
		}
	}

	return gqlError(e?.message ?? "mutation failed", "INTERNAL_SERVER_ERROR");
}
