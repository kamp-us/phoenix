/**
 * The pure golden-pointer core: resolve a surface to its immutable depo URL, and
 * bless (move the pointer) immutably. Asserted with no fs, no network (ADR 0040
 * taxonomy: pure logic → unit) — this is the "baseline resolution" AC.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	blessedSurfaces,
	blessSurface,
	type GoldenPointer,
	isSha256Hex,
	resolveGoldenEntry,
} from "./golden-pointer.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const pointer: GoldenPointer = {
	"/sozluk": {sha256: SHA_A, blessedDate: "2026-07-14", intent: "sözlük home, seeded corpus"},
	"/sozluk:empty": {sha256: SHA_B, blessedDate: "2026-07-14", intent: "sözlük empty state"},
};

describe("resolveGoldenEntry — baseline resolution", () => {
	it("resolves a blessed surface to its current golden sha (the pointer's baseline)", () => {
		assert.strictEqual(resolveGoldenEntry(pointer, "/sozluk")?.sha256, SHA_A);
	});

	it("returns null for an unblessed surface (nothing to compare against yet)", () => {
		assert.strictEqual(resolveGoldenEntry(pointer, "/pano"), null);
	});

	it("keys off the exact surface-id, so a state variant is its own golden", () => {
		assert.strictEqual(resolveGoldenEntry(pointer, "/sozluk:empty")?.sha256, SHA_B);
	});
});

describe("isSha256Hex", () => {
	it("accepts a 64-hex stem and rejects a URL / .png / short / uppercase stem", () => {
		assert.isTrue(isSha256Hex(SHA_A));
		assert.isFalse(isSha256Hex(`${SHA_A}.png`));
		assert.isFalse(isSha256Hex(`https://depo.kamp.us/${SHA_A}.png`));
		assert.isFalse(isSha256Hex("abc"));
		assert.isFalse(isSha256Hex("A".repeat(64)));
	});
});

describe("blessSurface — the pointer move (re-bless), immutable", () => {
	it("adds a new surface without mutating the input pointer", () => {
		const next = blessSurface(pointer, {
			surfaceId: "/pano",
			sha256: SHA_A,
			blessedDate: "2026-07-14",
			intent: "pano feed, seeded",
		});
		assert.strictEqual(resolveGoldenEntry(next, "/pano")?.sha256, SHA_A);
		// input untouched — the audited baseline can't be clobbered under a reader
		assert.strictEqual(resolveGoldenEntry(pointer, "/pano"), null);
	});

	it("moves an existing surface's pointer to a new sha (a re-bless is a new content address)", () => {
		const next = blessSurface(pointer, {
			surfaceId: "/sozluk",
			sha256: SHA_B,
			blessedDate: "2026-07-15",
			intent: "re-bless after nav redesign",
		});
		assert.strictEqual(resolveGoldenEntry(next, "/sozluk")?.sha256, SHA_B);
		assert.strictEqual(resolveGoldenEntry(pointer, "/sozluk")?.sha256, SHA_A); // old pointer unchanged
	});

	it("rejects a non-sha256 stem (.png / URL is a caller bug — invalid pointer unrepresentable)", () => {
		assert.throws(
			() =>
				blessSurface(pointer, {
					surfaceId: "/x",
					sha256: `${SHA_A}.png`,
					blessedDate: "2026-07-14",
					intent: "x",
				}),
			/64-hex/,
		);
	});

	it("rejects an empty surface-id and an empty intent", () => {
		assert.throws(
			() =>
				blessSurface(pointer, {
					surfaceId: "",
					sha256: SHA_A,
					blessedDate: "2026-07-14",
					intent: "x",
				}),
			/empty surface-id/,
		);
		assert.throws(
			() =>
				blessSurface(pointer, {
					surfaceId: "/x",
					sha256: SHA_A,
					blessedDate: "2026-07-14",
					intent: "  ",
				}),
			/non-empty intent/,
		);
	});
});

describe("blessedSurfaces", () => {
	it("lists blessed surface-ids sorted (stable, reviewable)", () => {
		assert.deepStrictEqual(blessedSurfaces(pointer), ["/sozluk", "/sozluk:empty"]);
	});
});
