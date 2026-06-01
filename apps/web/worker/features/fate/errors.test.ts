/**
 * `encodeFateError` isolation tests — the `_tag` → wire-code mapping.
 *
 * The codes are the contract shared with the SPA (`mutationErrorCodes`), so
 * each arm is pinned: one `_tag`, one wire code.
 */

import {FateRequestError} from "@nkzw/fate/server";
import {describe, expect, expectTypeOf, it} from "vitest";
import {DrizzleError} from "../../db/Drizzle";
import {CommentNotFound} from "../pano/errors";
import {Unauthorized} from "../pasaport/Auth";
import {UserNotFound} from "../pasaport/errors";
import {DefinitionNotFound} from "../sozluk/errors";
import {VoteTargetNotFound} from "../vote/errors";
import {encodeFateError, type FateErrorTag, WIRE_CODE_BY_TAG} from "./errors";

const code = (tag: string, extra: Record<string, unknown> = {}) =>
	encodeFateError({_tag: tag, ...extra}).code;

describe("encodeFateError", () => {
	it("passes a FateRequestError through verbatim", () => {
		const e = new FateRequestError("NOT_FOUND", "x");
		expect(encodeFateError(e)).toBe(e);
	});

	it("maps Auth/infra tags", () => {
		expect(code("Unauthorized")).toBe("UNAUTHORIZED");
		expect(code("@phoenix/Drizzle/Error")).toBe("INTERNAL_SERVER_ERROR");
	});

	it("maps Pasaport tags", () => {
		expect(code("pasaport/UsernameInvalid", {code: "too_short"})).toBe("TOO_SHORT");
		expect(code("pasaport/UsernameInvalid")).toBe("BAD_REQUEST");
		expect(code("pasaport/UsernameTaken")).toBe("TAKEN");
		expect(code("pasaport/UsernameAlreadySet")).toBe("ALREADY_SET");
		expect(code("pasaport/UserNotFound")).toBe("USER_NOT_FOUND");
	});

	it("maps Sozluk tags", () => {
		expect(code("sozluk/BodyRequired")).toBe("BODY_REQUIRED");
		expect(code("sozluk/BodyTooLong")).toBe("BODY_TOO_LONG");
		expect(code("sozluk/DefinitionNotFound")).toBe("DEFINITION_NOT_FOUND");
		expect(code("sozluk/UnauthorizedDefinitionMutation")).toBe("UNAUTHORIZED");
	});

	it("maps Pano tags", () => {
		expect(code("pano/PostValidation", {code: "title_required"})).toBe("TITLE_REQUIRED");
		expect(code("pano/CommentValidation")).toBe("BAD_REQUEST");
		expect(code("pano/PostNotFound")).toBe("POST_NOT_FOUND");
		expect(code("pano/CommentNotFound")).toBe("COMMENT_NOT_FOUND");
		expect(code("pano/UnauthorizedPostMutation")).toBe("UNAUTHORIZED");
		expect(code("pano/UnauthorizedCommentMutation")).toBe("UNAUTHORIZED");
	});

	it("maps Vote target-not-found", () => {
		expect(code("vote/VoteTargetNotFound")).toBe("BAD_REQUEST");
	});

	it("falls through unknown tags and plain values to INTERNAL_SERVER_ERROR", () => {
		expect(code("totally/Unknown")).toBe("INTERNAL_SERVER_ERROR");
		expect(encodeFateError(new Error("x")).code).toBe("INTERNAL_SERVER_ERROR");
		expect(encodeFateError(null).code).toBe("INTERNAL_SERVER_ERROR");
		expect(encodeFateError("string").code).toBe("INTERNAL_SERVER_ERROR");
	});

	it("always produces a FateRequestError", () => {
		expect(encodeFateError({_tag: "Unauthorized"})).toBeInstanceOf(FateRequestError);
		expect(encodeFateError(undefined)).toBeInstanceOf(FateRequestError);
	});

	describe("exhaustiveness", () => {
		// The registry is keyed by the union of every feature error `_tag`. If a
		// new `Data.TaggedError` is added without a registry entry, `FateErrorTag`
		// widens and the `Record<FateErrorTag, ...>` literal fails to typecheck —
		// the silent INTERNAL_SERVER_ERROR downgrade becomes a compile error.
		it("has a registry entry for every known feature tag", () => {
			expect(WIRE_CODE_BY_TAG).toHaveProperty("Unauthorized");
			expect(WIRE_CODE_BY_TAG).toHaveProperty("@phoenix/Drizzle/Error");
			expect(WIRE_CODE_BY_TAG).toHaveProperty("pasaport/UserNotFound");
			expect(WIRE_CODE_BY_TAG).toHaveProperty("sozluk/DefinitionNotFound");
			expect(WIRE_CODE_BY_TAG).toHaveProperty("pano/CommentNotFound");
			expect(WIRE_CODE_BY_TAG).toHaveProperty("vote/VoteTargetNotFound");
		});

		// The union is derived from the actual error classes, so every class's
		// `_tag` is assignable to `FateErrorTag` — proving the link is not a
		// hand-maintained string list that can drift from the classes.
		it("derives the tag union from the real error classes", () => {
			expectTypeOf(new Unauthorized({message: "x"})._tag).toExtend<FateErrorTag>();
			expectTypeOf(new DrizzleError({cause: null})._tag).toExtend<FateErrorTag>();
			expectTypeOf(new UserNotFound({message: "x"})._tag).toExtend<FateErrorTag>();
			expectTypeOf(
				new DefinitionNotFound({definitionId: "x", message: "y"})._tag,
			).toExtend<FateErrorTag>();
			expectTypeOf(
				new CommentNotFound({commentId: "x", message: "y"})._tag,
			).toExtend<FateErrorTag>();
			expectTypeOf(
				new VoteTargetNotFound({targetKind: "post", targetId: "x", message: "y"})._tag,
			).toExtend<FateErrorTag>();
		});
	});
});
