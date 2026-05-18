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
	CommentNotFound,
	CommentValidation,
	PostNotFound,
	PostValidation,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
} from "../../worker/features/pano/errors";
import {
	UserNotFound,
	UsernameAlreadySet,
	UsernameInvalid,
	UsernameTaken,
} from "../../worker/features/pasaport/errors";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "../../worker/features/sozluk/errors";
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

	it("UnauthorizedDefinitionMutation (tagged) → UNAUTHORIZED", () => {
		const out = encodeMutationError(
			new UnauthorizedDefinitionMutation({
				definitionId: "def_1",
				message: "not authorized to mutate definition def_1",
			}),
		);
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("UnauthorizedDefinitionMutationError (legacy name) → UNAUTHORIZED", () => {
		// RPC-marshalled / legacy class-name path: still mapped through the
		// `name`-based fallback so any plain-Error escape hatch keeps producing
		// the same wire code.
		const marshalled = new Error("not authorized");
		marshalled.name = "UnauthorizedDefinitionMutationError";
		const out = encodeMutationError(marshalled);
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("UnauthorizedPostMutation (tagged) → UNAUTHORIZED", () => {
		const out = encodeMutationError(
			new UnauthorizedPostMutation({postId: "post_1", message: "not authorized"}),
		);
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("UnauthorizedCommentMutation (tagged) → UNAUTHORIZED", () => {
		const out = encodeMutationError(
			new UnauthorizedCommentMutation({commentId: "c_1", message: "not authorized"}),
		);
		expect(codeOf(out)).toBe("UNAUTHORIZED");
	});

	it("DefinitionNotFound (tagged) → DEFINITION_NOT_FOUND", () => {
		const e = new DefinitionNotFound({
			definitionId: "def_1",
			message: "definition def_1 not found",
		});
		const out = encodeMutationError(e);
		expect(codeOf(out)).toBe("DEFINITION_NOT_FOUND");
		expect(out.message).toBe(e.message);
	});

	it("PostNotFound (tagged) → POST_NOT_FOUND", () => {
		const out = encodeMutationError(
			new PostNotFound({postId: "p_1", message: "post p_1 not found"}),
		);
		expect(codeOf(out)).toBe("POST_NOT_FOUND");
	});

	it("CommentNotFound (tagged) → COMMENT_NOT_FOUND", () => {
		const out = encodeMutationError(
			new CommentNotFound({commentId: "c_1", message: "comment c_1 not found"}),
		);
		expect(codeOf(out)).toBe("COMMENT_NOT_FOUND");
	});

	it("BodyRequired (tagged) → BODY_REQUIRED", () => {
		const out = encodeMutationError(new BodyRequired({message: "boş"}));
		expect(codeOf(out)).toBe("BODY_REQUIRED");
	});

	it("BodyTooLong (tagged) → BODY_TOO_LONG", () => {
		const out = encodeMutationError(new BodyTooLong({max: 10_000, message: "uzun"}));
		expect(codeOf(out)).toBe("BODY_TOO_LONG");
	});

	it("PostValidation (tagged) uses its `code` upcased", () => {
		const out = encodeMutationError(new PostValidation({code: "title_too_long", message: "uzun"}));
		expect(codeOf(out)).toBe("TITLE_TOO_LONG");
	});

	it("CommentValidation (tagged) uses its `code` upcased", () => {
		const out = encodeMutationError(
			new CommentValidation({code: "parent_not_found", message: "yok"}),
		);
		expect(codeOf(out)).toBe("PARENT_NOT_FOUND");
	});

	it("UsernameInvalid uses its `code` upcased", () => {
		const out = encodeMutationError(
			new UsernameInvalid({code: "invalid_format", message: "kullanıcı adı geçersiz"}),
		);
		expect(codeOf(out)).toBe("INVALID_FORMAT");
	});

	it("UsernameInvalid too_short → TOO_SHORT", () => {
		const out = encodeMutationError(new UsernameInvalid({code: "too_short", message: "kısa"}));
		expect(codeOf(out)).toBe("TOO_SHORT");
	});

	it("UsernameTaken → TAKEN", () => {
		const out = encodeMutationError(new UsernameTaken({message: "alınmış"}));
		expect(codeOf(out)).toBe("TAKEN");
	});

	it("UsernameAlreadySet → ALREADY_SET", () => {
		const out = encodeMutationError(new UsernameAlreadySet({message: "zaten"}));
		expect(codeOf(out)).toBe("ALREADY_SET");
	});

	it("UserNotFound → USER_NOT_FOUND", () => {
		const out = encodeMutationError(new UserNotFound({message: "bulunamadı"}));
		expect(codeOf(out)).toBe("USER_NOT_FOUND");
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
