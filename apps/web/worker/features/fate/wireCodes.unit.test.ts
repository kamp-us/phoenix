/**
 * SPA wire-code list ⇄ server config guard. If the SPA list omits a code the server
 * can emit, `decodeFateWireCode` silently drifts that code to its
 * `INTERNAL_SERVER_ERROR` fallback at runtime — this fails CI on that drift instead.
 * The AST walk behind `declaredWireCodes` is tested package-side.
 */

import * as FateEffect from "@kampus/fate-effect";
import {declaredWireCodes} from "@kampus/fate-effect";
import {describe, expect, it} from "vitest";
import {decodeFateWireCode, FATE_WIRE_CODES} from "../../../src/lib/fateWireCodes.ts";
import {THROTTLE_WIRE_CODES} from "../throttle/wire-codes.ts";
import {fateConfig} from "./config.ts";

describe("wire-code contract", () => {
	const spaCodes: ReadonlySet<string> = new Set(FATE_WIRE_CODES);

	// The throttle codes are injected at the fate composition seam (ADR 0177) and have
	// no declared error union to walk, so they must be unioned in by hand.
	const serverCodes: ReadonlySet<string> = new Set([
		...declaredWireCodes(fateConfig),
		...THROTTLE_WIRE_CODES,
	]);

	it("the annotation key is exported under its one canonical name `FateWireCode`", () => {
		// A value-only guard would let the export be renamed while the string stays
		// the same, and every author site spells the symbol (#1032).
		expect(FateEffect).toHaveProperty("FateWireCode");
		expect(FateEffect.FateWireCode).toBe("fate-effect/wireCode");
		expect(FateEffect).not.toHaveProperty("ErrorCode");
	});

	it("the walk finds phoenix's declared vocabulary (sanity floor)", () => {
		// One code per error surface, so a dropped error union names the hole instead
		// of the subset check below quietly passing over a shrunken set.
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

	it("every server-emittable code decodes to itself, never the INTERNAL_SERVER_ERROR fallback", () => {
		expect(decodeFateWireCode("UNAUTHORIZED")).toBe("UNAUTHORIZED");
		for (const code of serverCodes) {
			expect(decodeFateWireCode(code)).toBe(code);
		}
		// An unknown code must be the ONLY thing reaching the call site's
		// `?? "INTERNAL_SERVER_ERROR"` fallback.
		expect(decodeFateWireCode("DEFINITELY_NOT_A_WIRE_CODE")).toBeNull();
	});
});
