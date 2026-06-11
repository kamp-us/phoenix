/**
 * SPA wire-code list ⇄ server config guard (T0).
 *
 * The server derives wire codes from the `WireCode` annotation on each
 * error class (`.patterns/fate-effect-wire-errors.md`), but the SPA's
 * `MUTATION_ERROR_CODES` (`src/lib/mutationErrorCodes.ts`) is a hand-kept
 * `as const` list. A server `code` the SPA list omits silently decodes to the
 * SPA's `INTERNAL_SERVER_ERROR` fallback (`decodeMutationErrorCode` returns
 * `null`) at runtime, untested.
 *
 * This is a *guard*, not a red→green feature — it passes today (no drift). It
 * derives the closed set of codes the server can emit from `fateConfig`
 * itself: every operation's DECLARED error union is walked (union members'
 * `WireCode` annotations — annotations land on each class's AST, so the
 * registered config is the single source), plus the two codes the package can
 * always emit independent of any declaration (`INTERNAL_SERVER_ERROR` for
 * defects/un-annotated failures, `VALIDATION_ERROR` for Schema rejections).
 * A future server-only code addition — a new annotated error class declared
 * on any registered operation — fails CI here instead of degrading silently
 * in the browser.
 *
 * Sources are excluded by construction: loaders have `E = never` (the
 * loader/resolver split), so they declare no errors to walk.
 *
 * The worker tsconfig cross-includes `src/lib/`, so this worker-side test
 * imports the SPA constant directly.
 */

import {
	INTERNAL_WIRE_CODE,
	InputValidationError,
	WireCode,
	wireCodeOfClass,
} from "@phoenix/fate-effect";
import * as Predicate from "effect/Predicate";
import {describe, expect, it} from "vitest";
import {MUTATION_ERROR_CODES} from "../../../src/lib/mutationErrorCodes.ts";
import {fateConfig} from "./config.ts";

/**
 * Collect every `WireCode` annotation reachable from one Schema AST node:
 * the node's own annotation plus (for a union) each member's. Structural
 * guards throughout — the walk must not assume AST internals beyond what it
 * reads (the same defensive shape as the package's `wireCodeOfClass`).
 */
function collectWireCodes(ast: unknown, out: Set<string>): void {
	if (Predicate.hasProperty(ast, "annotations")) {
		const annotations: unknown = ast.annotations;
		if (Predicate.hasProperty(annotations, WireCode)) {
			const code: unknown = annotations[WireCode];
			if (typeof code === "string") out.add(code);
		}
	}
	// A `Schema.Union([...])` AST carries its members on `types`.
	if (Predicate.hasProperty(ast, "types") && Array.isArray(ast.types)) {
		for (const member of ast.types) collectWireCodes(member, out);
	}
}

/** The declared error codes of one config record's entries. */
function declaredCodes(record: Record<string, unknown>, out: Set<string>): void {
	for (const entry of Object.values(record)) {
		if (!Predicate.hasProperty(entry, "definition")) continue;
		const definition: unknown = entry.definition;
		if (!Predicate.hasProperty(definition, "error")) continue;
		const error: unknown = definition.error;
		if (error !== undefined && Predicate.hasProperty(error, "ast")) {
			collectWireCodes(error.ast, out);
		}
	}
}

describe("wire-code contract", () => {
	const spaCodes: ReadonlySet<string> = new Set(MUTATION_ERROR_CODES);

	/** Every code the server can put on the wire, derived from the config. */
	const serverCodes = new Set<string>([INTERNAL_WIRE_CODE]);
	const validationCode = wireCodeOfClass(InputValidationError);
	if (validationCode !== undefined) serverCodes.add(validationCode);
	declaredCodes(fateConfig.queries ?? {}, serverCodes);
	declaredCodes(fateConfig.lists ?? {}, serverCodes);
	declaredCodes(fateConfig.mutations ?? {}, serverCodes);

	it("the config walk actually finds the declared vocabulary (sanity floor)", () => {
		// Canary codes — one per error surface (package gate, sozluk, pano,
		// pasaport). If the AST walk silently stops finding annotations (an
		// effect Schema internals change), this fails loudly instead of the
		// subset check passing vacuously over an empty set.
		for (const canary of [
			"UNAUTHORIZED",
			"VALIDATION_ERROR",
			"BODY_REQUIRED",
			"POST_NOT_FOUND",
			"TAKEN",
		]) {
			expect(serverCodes).toContain(canary);
		}
	});

	it("the SPA list covers every code the server can emit", () => {
		const missing = [...serverCodes].filter((code) => !spaCodes.has(code));
		expect(missing).toEqual([]);
	});
});
