/**
 * SPA wire-code list ⇄ server registry guard.
 *
 * The server's `WIRE_CODE_BY_TAG` is exhaustiveness-gated against `FateErrorTag`,
 * but the SPA's `MUTATION_ERROR_CODES` (`src/lib/mutationErrorCodes.ts`) is a
 * hand-kept `as const` list. A server `code` the SPA list omits silently decodes
 * to the SPA's `INTERNAL_SERVER_ERROR` fallback (`decodeMutationErrorCode`
 * returns `null`) at runtime, untested.
 *
 * This is a *guard*, not a red→green feature — it passes today (no drift). It
 * asserts every wire `code` the server can emit (`WIRE_CODES`, derived from the
 * registry + the always-present fallbacks) is present in the SPA list, so a
 * future server-only code addition fails CI instead of degrading silently in the
 * browser. (Proven to bite: temporarily adding a server-only code to `WIRE_CODES`
 * makes this test fail.)
 *
 * The worker tsconfig cross-includes `src/lib/`, so this worker-side test imports
 * the SPA constant directly.
 */

import {describe, expect, it} from "vitest";
import {MUTATION_ERROR_CODES} from "../../../src/lib/mutationErrorCodes.ts";
import {WIRE_CODES} from "./errors.ts";

describe("wire-code contract", () => {
	const spaCodes: ReadonlySet<string> = new Set(MUTATION_ERROR_CODES);

	it("the SPA list covers every code the server can emit", () => {
		const missing = [...WIRE_CODES].filter((code) => !spaCodes.has(code));
		expect(missing).toEqual([]);
	});
});
