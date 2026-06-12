/**
 * SPA wire-code list ⇄ server config guard (T0).
 *
 * The server derives wire codes from the `ErrorCode` annotation on each
 * error class (`.patterns/fate-effect-wire-errors.md`), but the SPA's
 * `MUTATION_ERROR_CODES` (`src/lib/mutationErrorCodes.ts`) is a hand-kept
 * `as const` list. A server `code` the SPA list omits silently decodes to the
 * SPA's `INTERNAL_SERVER_ERROR` fallback (`decodeMutationErrorCode` returns
 * `null`) at runtime, untested.
 *
 * This is a *guard*, not a red→green feature — it passes today (no drift).
 * The closed set of codes the server can emit comes from the package's
 * canonical walker, `declaredWireCodes(fateConfig)`: every operation's
 * DECLARED error union plus the two package fallbacks
 * (`INTERNAL_SERVER_ERROR`, `VALIDATION_ERROR`). The AST walk itself — and
 * its drift canary — live package-side (`Server.unit.test.ts`); this test
 * owns only the two phoenix-level assertions. A future server-only code
 * addition — a new annotated error class declared on any registered
 * operation — fails CI here instead of degrading silently in the browser.
 *
 * The worker tsconfig cross-includes `src/lib/`, so this worker-side test
 * imports the SPA constant directly.
 */

import {declaredWireCodes} from "@phoenix/fate-effect";
import {describe, expect, it} from "vitest";
import {MUTATION_ERROR_CODES} from "../../../src/lib/mutationErrorCodes.ts";
import {fateConfig} from "./config.ts";

describe("wire-code contract", () => {
	const spaCodes: ReadonlySet<string> = new Set(MUTATION_ERROR_CODES);

	/** Every code the server can put on the wire, derived from the config. */
	const serverCodes = declaredWireCodes(fateConfig);

	it("the walk finds phoenix's declared vocabulary (sanity floor)", () => {
		// One code per error surface (package gate, sozluk, pano, pasaport):
		// if the config stops declaring its vocabulary — a feature's error
		// union dropped from a registered operation — this names the hole
		// instead of the subset check below passing over a shrunken set.
		for (const floor of [
			"UNAUTHORIZED",
			"VALIDATION_ERROR",
			"BODY_REQUIRED",
			"POST_NOT_FOUND",
			"TAKEN",
		]) {
			expect(serverCodes).toContain(floor);
		}
	});

	it("the SPA list covers every code the server can emit", () => {
		const missing = [...serverCodes].filter((code) => !spaCodes.has(code));
		expect(missing).toEqual([]);
	});
});
