/**
 * Round-trip codec between worker-side domain error classes and the
 * wire-format `extensions.code` strings the SPA matches on.
 *
 * Encode side (worker): given any thrown error from a mutation resolver,
 * produce a `GraphQLError` with a stable `extensions.code`. The Effect
 * `resolver()` wrapper invokes this in its catch path, so mutation resolvers
 * no longer carry inline `try { ... } catch (err) { throw mapXMutationError(err) }`
 * boilerplate.
 *
 * Decode side (SPA): given a wire-format code string, return the same string
 * narrowed to {@link MutationErrorCode} when it's a known member of the union,
 * or `null` otherwise. The SPA can then `switch` on the typed value instead
 * of stringly-comparing against `"UNAUTHORIZED"` etc.
 *
 * Why match on `name` (not `instanceof`): agent errors cross the workerd RPC
 * boundary as plain `Error` instances — class identity is lost in marshaling,
 * but `name` + `code` survive. We support both shapes so direct in-worker
 * throws and RPC-marshalled throws encode identically.
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

/**
 * Map a thrown value from inside a mutation resolver onto a `GraphQLError`
 * with a stable wire-format `extensions.code`. Idempotent on
 * already-encoded `GraphQLError` inputs.
 *
 * Matches by:
 * - `_tag === "Unauthorized"` for the Effect tagged failure raised by
 *   `Auth.required`.
 * - `name === "<DomainErrorClass>"` for everything else, since the workerd
 *   RPC boundary strips class identity but preserves `name` + `code`.
 *
 * Unknown shapes fall through to `INTERNAL_SERVER_ERROR` so the SPA can
 * render a generic toast instead of Yoga's masked-error placeholder.
 */
export function encodeMutationError(err: unknown): GraphQLError {
	if (err instanceof GraphQLError) return err;

	const e = err as (Error & {code?: string; _tag?: string}) | null | undefined;
	const tag = e?._tag;
	const name = e?.name;

	if (tag === "Unauthorized") {
		return new GraphQLError("not authorized", {extensions: {code: "UNAUTHORIZED"}});
	}

	switch (name) {
		case "UnauthorizedDefinitionMutationError":
		case "UnauthorizedPostMutationError":
		case "UnauthorizedCommentMutationError":
			return new GraphQLError("not authorized", {extensions: {code: "UNAUTHORIZED"}});

		case "DefinitionNotFoundError":
			return new GraphQLError(e?.message ?? "definition not found", {
				extensions: {code: "DEFINITION_NOT_FOUND"},
			});

		case "PostNotFoundError":
			return new GraphQLError(e?.message ?? "post not found", {
				extensions: {code: "POST_NOT_FOUND"},
			});

		case "CommentNotFoundError":
			return new GraphQLError(e?.message ?? "comment not found", {
				extensions: {code: "COMMENT_NOT_FOUND"},
			});

		case "UsernameValidationError":
		case "DefinitionValidationError":
		case "PostValidationError":
		case "CommentValidationError": {
			const code = e?.code ? e.code.toUpperCase() : "BAD_REQUEST";
			return new GraphQLError(e?.message ?? "validation failed", {
				extensions: {code},
			});
		}
	}

	return new GraphQLError(e?.message ?? "mutation failed", {
		extensions: {code: "INTERNAL_SERVER_ERROR"},
	});
}
