/**
 * fate seam — black-box against the deployed worker `/fate` route.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104) and needs no namespace
 * token: it seeds nothing. The `health` read touches a global `definitions` count
 * other files seed into, so it asserts the SHAPE (a number ≥ 0), not an exact value;
 * the anonymous-`me` UNAUTHORIZED gate is a fixed route, nothing to scope.
 */
import {describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";

const h = sharedStack();

describe("fate seam — /fate", () => {
	it("health resolves data produced by an Effect service method", async () => {
		const result = await h.fate({
			kind: "query",
			name: "health",
			select: ["status", "definitions"],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {status: string; definitions: number};
		expect(data.status).toBe("ok");
		// The exact count is a shared-D1 aggregate (other files seed definitions), so
		// assert the type rather than a value.
		expect(typeof data.definitions).toBe("number");
		expect(data.definitions).toBeGreaterThanOrEqual(0);
	});

	it("a tagged domain error serializes as {ok:false, error:{code}} — Unauthorized → UNAUTHORIZED", async () => {
		// `me` is anonymous here (no session cookie) → CurrentUser.required fails
		// with the `Unauthorized` tagged error → encodeWireError → UNAUTHORIZED.
		const result = await h.fate({
			kind: "query",
			name: "me",
			select: ["id"],
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});
