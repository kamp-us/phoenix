/**
 * The stored bytes of the admin grant, asserted without a DB (ADR 0082 unit tier): the
 * relation and object the worker's read keys on. What `assignAdmin`, `revokeAdmin` and
 * `listAdmins` write and read is only-wrong-if-the-DB-differs, so it lives in the
 * `integration` tier on real D1 (`tests/integration/grant.test.ts`).
 */
import {assert, describe, it} from "vitest";
import {ADMIN, PLATFORM} from "./grant.ts";

describe("the admin grant is keyed on the canonical platform node", () => {
	it("ADMIN is the `admin` relation and PLATFORM is key(platform) = 'platform:platform'", () => {
		assert.strictEqual(ADMIN, "admin");
		// The write key MUST equal the worker read key (`RelationStoreLive` over `key(platform)`),
		// else a granted admin is denied — the divergence the integration seam guards end to end.
		assert.strictEqual(PLATFORM, "platform:platform");
	});
});
