/**
 * The shared `<kind>:<id>` target-key codec — the one encode/decode pair the
 * vote/report/divan surfaces route through. Its rejections are what the divan collapses
 * to the invisible `Denied`.
 */
import {assert, describe, it} from "@effect/vitest";
import {parseTargetKey, TARGET_KINDS, targetKey} from "./target-kind.ts";

describe("targetKey — the <kind>:<id> encode", () => {
	it("spells kind:id, the view-id format", () => {
		assert.strictEqual(targetKey("post", "p-1"), "post:p-1");
		assert.strictEqual(targetKey("definition", "d-9"), "definition:d-9");
		assert.strictEqual(targetKey("comment", "c-3"), "comment:c-3");
	});
});

describe("parseTargetKey — the <kind>:<id> decode", () => {
	it("round-trips every TargetKind (parse ∘ encode = identity)", () => {
		for (const kind of TARGET_KINDS) {
			assert.deepStrictEqual(parseTargetKey(targetKey(kind, "x-42")), {kind, id: "x-42"});
		}
	});

	it("splits on the FIRST separator, so an id may itself contain a colon", () => {
		assert.deepStrictEqual(parseTargetKey("post:a:b:c"), {kind: "post", id: "a:b:c"});
	});

	it("rejects a key with no separator", () => {
		assert.strictEqual(parseTargetKey("postp-1"), null);
	});

	it("rejects an empty kind (leading separator)", () => {
		assert.strictEqual(parseTargetKey(":p-1"), null);
	});

	it("rejects an empty id (trailing separator)", () => {
		assert.strictEqual(parseTargetKey("post:"), null);
	});

	it("rejects an unknown kind outside TARGET_KINDS", () => {
		assert.strictEqual(parseTargetKey("dm:m-1"), null);
		assert.strictEqual(parseTargetKey("tanim:d-1"), null);
	});
});
