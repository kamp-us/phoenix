/**
 * The throttle wire-error annotation pin (ADR 0177) — `RateLimitExceeded` carries
 * `RATE_LIMIT_EXCEEDED` and round-trips through `encodeWireError` with its own
 * message. The aggregate `fate/wireCodes.unit.test.ts` guard proves the SPA list
 * covers this seam-injected code; this pins the class→code binding itself, the
 * throttle twin of `fate/wireCodes-per-class.unit.test.ts` (the seam-injected
 * code has no declared union, so it can't be pinned by that staleness guard).
 */
import {encodeWireError, wireCodeOfClass} from "@kampus/fate-effect";
import {describe, expect, it} from "vitest";
import {RateLimitExceeded} from "./errors.ts";

describe("throttle wire error", () => {
	it("RateLimitExceeded carries RATE_LIMIT_EXCEEDED", () => {
		expect(wireCodeOfClass(RateLimitExceeded)).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("encodes to its wire code with its own message", () => {
		const wire = encodeWireError(new RateLimitExceeded({message: "slow down", retryAfterMs: 1000}));
		expect(wire.code).toBe("RATE_LIMIT_EXCEEDED");
		expect(wire.message).toBe("slow down");
	});
});
