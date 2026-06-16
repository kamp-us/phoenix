/**
 * SPA wire-code list ⇄ server config guard (T0).
 *
 * The server derives wire codes from each error class's `ErrorCode` annotation
 * (`.patterns/fate-effect-wire-errors.md`), but the SPA's `MUTATION_ERROR_CODES`
 * (`src/lib/mutationErrorCodes.ts`) is a hand-kept `as const` list — a server
 * code the SPA omits silently decodes to its `INTERNAL_SERVER_ERROR` fallback at
 * runtime, untested. This guard fails CI on that drift instead. The closed set
 * comes from the package walker `declaredWireCodes(fateConfig)`; the AST walk and
 * its drift canary live package-side (`Server.unit.test.ts`), so this owns only
 * the two phoenix-level assertions.
 *
 * The worker tsconfig cross-includes `src/lib/`, so this worker-side test imports
 * the SPA constant directly.
 */

import {declaredWireCodes} from "@kampus/fate-effect";
import {describe, expect, it} from "vitest";
import {MUTATION_ERROR_CODES} from "../../../src/lib/mutationErrorCodes.ts";
import {fateConfig} from "./config.ts";

describe("wire-code contract", () => {
	const spaCodes: ReadonlySet<string> = new Set(MUTATION_ERROR_CODES);

	const serverCodes = declaredWireCodes(fateConfig);

	it("the walk finds phoenix's declared vocabulary (sanity floor)", () => {
		// One code per error surface (package gate, sozluk, pano, pasaport): if a
		// feature's error union drops from a registered operation, this names the
		// hole instead of the subset check below passing over a shrunken set.
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
