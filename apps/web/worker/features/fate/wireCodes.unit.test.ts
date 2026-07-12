/**
 * SPA wire-code list ⇄ server config guard (unit tier).
 *
 * The server derives wire codes from each error class's `FateWireCode`
 * annotation (`.patterns/fate-effect-wire-errors.md`); the SPA's
 * `FATE_WIRE_CODES` (`src/lib/fateWireCodes.ts`) is the literal authored source
 * the decoder narrows to. The two ends are bound by this guard, not by hope: if
 * the SPA list omits a code the server can emit, `decodeFateWireCode` would drift
 * that code to its `INTERNAL_SERVER_ERROR` fallback at runtime — so this test
 * fails CI on that drift before it ships. The closed server set comes from the
 * package walker `declaredWireCodes(fateConfig)`; the AST walk and its drift
 * canary live package-side (`Server.unit.test.ts`), so this owns only the
 * phoenix-level assertions.
 *
 * The worker tsconfig cross-includes `src/lib/`, so this worker-side test imports
 * the SPA constant + decoder directly.
 */

import * as FateEffect from "@kampus/fate-effect";
import {declaredWireCodes} from "@kampus/fate-effect";
import {describe, expect, it} from "vitest";
import {decodeFateWireCode, FATE_WIRE_CODES} from "../../../src/lib/fateWireCodes.ts";
import {THROTTLE_WIRE_CODES} from "../throttle/wire-codes.ts";
import {fateConfig} from "./config.ts";

describe("wire-code contract", () => {
	const spaCodes: ReadonlySet<string> = new Set(FATE_WIRE_CODES);

	// The server can emit two flavors: codes from a mutation's DECLARED error union
	// (what `declaredWireCodes` walks) PLUS the throttle codes injected at the fate
	// composition seam (ADR 0177) — the latter have no declared union to walk, so
	// they are unioned in here so the SPA-coverage assertion still binds them.
	const serverCodes: ReadonlySet<string> = new Set([
		...declaredWireCodes(fateConfig),
		...THROTTLE_WIRE_CODES,
	]);

	it("the annotation key is exported under its one canonical name `FateWireCode`", () => {
		// Names drift under a value-only guard (#1032): the codec reads the
		// annotation by the `FateWireCode` *symbol* every author site spells, so a
		// rename of the export — back to `ErrorCode` or any other — must fail CI
		// here, not just silently work because the underlying string is unchanged.
		expect(FateEffect).toHaveProperty("FateWireCode");
		expect(FateEffect.FateWireCode).toBe("fate-effect/wireCode");
		expect(FateEffect).not.toHaveProperty("ErrorCode");
	});

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

	it("every server-emittable code decodes to itself, never the INTERNAL_SERVER_ERROR fallback", () => {
		// The behavioral pin behind the coverage check: a real wire code must
		// render as its OWN code, not drift to the generic fallback. `UNAUTHORIZED`
		// is the canonical case — a known domain code the SPA must surface verbatim.
		expect(decodeFateWireCode("UNAUTHORIZED")).toBe("UNAUTHORIZED");
		for (const code of serverCodes) {
			expect(decodeFateWireCode(code)).toBe(code);
		}
		// An unknown code is the ONLY thing that falls through to null (the
		// `?? "INTERNAL_SERVER_ERROR"` fallback at the call site) — proving the
		// fallback is reserved for genuinely-unrecognized codes, not real ones.
		expect(decodeFateWireCode("DEFINITELY_NOT_A_WIRE_CODE")).toBeNull();
	});
});
