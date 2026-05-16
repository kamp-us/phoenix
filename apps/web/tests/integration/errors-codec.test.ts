/**
 * Round-trip codec between worker domain error classes and the wire-format
 * GraphQL error codes the SPA matches on.
 *
 * Encode side: domain class -> GraphQLError w/ extensions.code.
 * Decode side: extensions.code -> typed narrow union the SPA can switch on.
 *
 * This is a pure unit test — no DOs or D1 — but lives under tests/integration/
 * because that's the only path the project's vitest config picks up.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {GraphQLError} from "graphql";
import {describe, expect, it} from "vitest";
import {
	CommentNotFoundError,
	CommentValidationError,
	PostNotFoundError,
	PostValidationError,
	UnauthorizedCommentMutationError,
	UnauthorizedPostMutationError,
} from "../../worker/features/pano/PanoPost";
import {UsernameValidationError} from "../../worker/features/pasaport/module";
import {
	DefinitionNotFoundError,
	DefinitionValidationError,
	UnauthorizedDefinitionMutationError,
} from "../../worker/features/sozluk/SozlukTerm";
import {
	decodeMutationErrorCode,
	encodeMutationError,
	MUTATION_ERROR_CODES,
	type MutationErrorCode,
} from "../../worker/graphql/errors";
import {Unauthorized} from "../../worker/services/Auth";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

function codeOf(err: GraphQLError): string {
	return String((err.extensions as {code?: string}).code ?? "");
}

describe("encodeMutationError — domain class → GraphQL code", () => {
	it("Unauthorized (tagged) → UNAUTHORIZED", () => {
		const out = encodeMutationError(new Unauthorized({message: "no auth"}));
		expect(out).toBeInstanceOf(GraphQLError);
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("UnauthorizedDefinitionMutationError → UNAUTHORIZED", () => {
		const out = encodeMutationError(new UnauthorizedDefinitionMutationError("def_1"));
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("UnauthorizedPostMutationError → UNAUTHORIZED", () => {
		const out = encodeMutationError(new UnauthorizedPostMutationError("post_1"));
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("UnauthorizedCommentMutationError → UNAUTHORIZED", () => {
		const out = encodeMutationError(new UnauthorizedCommentMutationError("c_1"));
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("DefinitionNotFoundError → DEFINITION_NOT_FOUND", () => {
		const e = new DefinitionNotFoundError("def_1");
		const out = encodeMutationError(e);
		expect(codeOf(out)).toBe("DEFINITION_NOT_FOUND");
		expect(out.message).toBe(e.message);
	});

	it("PostNotFoundError → POST_NOT_FOUND", () => {
		const out = encodeMutationError(new PostNotFoundError("p_1"));
		expect(codeOf(out)).toBe("POST_NOT_FOUND");
	});

	it("CommentNotFoundError → COMMENT_NOT_FOUND", () => {
		const out = encodeMutationError(new CommentNotFoundError("c_1"));
		expect(codeOf(out)).toBe("COMMENT_NOT_FOUND");
	});

	it("DefinitionValidationError uses its `code` upcased", () => {
		const out = encodeMutationError(new DefinitionValidationError("body_required", "boş"));
		expect(codeOf(out)).toBe("BODY_REQUIRED");
	});

	it("PostValidationError uses its `code` upcased", () => {
		const out = encodeMutationError(new PostValidationError("title_too_long", "uzun"));
		expect(codeOf(out)).toBe("TITLE_TOO_LONG");
	});

	it("CommentValidationError uses its `code` upcased", () => {
		const out = encodeMutationError(new CommentValidationError("parent_not_found", "yok"));
		expect(codeOf(out)).toBe("PARENT_NOT_FOUND");
	});

	it("UsernameValidationError uses its `code` upcased", () => {
		const out = encodeMutationError(new UsernameValidationError("taken", "alınmış"));
		expect(codeOf(out)).toBe("TAKEN");
	});

	it("passes a pre-built GraphQLError through unchanged", () => {
		const original = new GraphQLError("explicit", {extensions: {code: "CUSTOM"}});
		const out = encodeMutationError(original);
		expect(out).toBe(original);
	});

	it("unknown Error → INTERNAL_SERVER_ERROR", () => {
		const out = encodeMutationError(new Error("boom"));
		expect(codeOf(out)).toBe("INTERNAL_SERVER_ERROR");
	});

	it("RPC-marshalled domain error (class identity lost) matched by `name`", () => {
		// Across the workerd RPC boundary the agent error arrives as a plain
		// Error with the original `name` preserved. The codec must match on it.
		const marshalled = new Error("not authorized to mutate post p_1");
		marshalled.name = "UnauthorizedPostMutationError";
		const out = encodeMutationError(marshalled);
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("RPC-marshalled validation error preserves the `code` upcased", () => {
		const marshalled = new Error("başlık boş olamaz") as Error & {code?: string};
		marshalled.name = "PostValidationError";
		marshalled.code = "title_required";
		const out = encodeMutationError(marshalled);
		expect(codeOf(out)).toBe("TITLE_REQUIRED");
	});
});

describe("decodeMutationErrorCode — wire code → typed narrowing", () => {
	it("returns the typed code for every known wire value", () => {
		for (const code of MUTATION_ERROR_CODES) {
			const decoded: MutationErrorCode | null = decodeMutationErrorCode(code);
			expect(decoded).toBe(code);
		}
	});

	it("returns null for an unrecognized code", () => {
		expect(decodeMutationErrorCode("FLOOFY")).toBeNull();
		expect(decodeMutationErrorCode(undefined)).toBeNull();
		expect(decodeMutationErrorCode(null)).toBeNull();
	});

	it("round-trips Unauthorized → wire → typed", () => {
		const encoded = encodeMutationError(new Unauthorized({message: "no auth"}));
		const wire = codeOf(encoded);
		expect(decodeMutationErrorCode(wire)).toBe("UNAUTHORIZED");
	});
});
