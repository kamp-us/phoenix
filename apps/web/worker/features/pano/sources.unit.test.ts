/**
 * Unit coverage for the pano fate **loader** seam (#1361). `tagSource.byIds` is the
 * one logic-bearing handler here: `Tag` is an embedded scalar with no table, so the
 * `kind → {kind, label: tagLabel(kind)}` map IS the whole fetch — it lives ONLY in
 * `sources.ts` and is exercised by no other test through the source interface.
 *
 * `postSource`/`commentSource` are pure pass-throughs to `Pano` (covered transitively
 * by their service tests — the deletion test), so they get no redundant seam test
 * here. The membership-stability invariant (ADR 0016 — `byIds` rows a pure function
 * of the id SET) is asserted on `tagSource`; the silent-read flavor for `Tag` is the
 * total kind→label map (an unknown kind falls back to its raw value, never a raised
 * miss). `tagSource.byIds` needs no service — the map is pure.
 */

import {it} from "@effect/vitest";
import {Effect} from "effect";
import {assert} from "vitest";
import {tagSource} from "./sources.ts";

/** Narrow an optional handler without a non-null assertion (mirrors Source.unit.test.ts). */
const required = <T>(value: T | undefined): T => {
	if (value === undefined) {
		throw new Error("expected the handler to be present");
	}
	return value;
};

const tagByIds = required(tagSource.handlers.byIds);

// --- tagSource.byIds: the kind → {kind, label} map --------------------------

it.effect("tagSource.byIds maps each canonical kind to its label via tagLabel", () =>
	Effect.gen(function* () {
		const rows = yield* tagByIds(["göster", "soru"]);
		assert.deepStrictEqual(rows, [
			{kind: "göster", label: "göster"},
			{kind: "soru", label: "soru"},
		]);
	}),
);

it.effect("tagSource.byIds resolves a legacy English alias to its canonical Turkish label", () =>
	Effect.gen(function* () {
		// `tagLabel` normalizes the seed-era alias `show` → `göster`; the `kind` field
		// stays the raw requested key (the ref the caller asked by).
		const rows = yield* tagByIds(["show"]);
		assert.deepStrictEqual(rows, [{kind: "show", label: "göster"}]);
	}),
);

// --- tagSource.byIds: silent-read — an unknown kind falls back, never fails --

it.effect("tagSource.byIds is silent on an unknown kind: it falls back to the raw value", () =>
	Effect.gen(function* () {
		const exit = yield* tagByIds(["nonexistent-kind"]).pipe(Effect.exit);
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") {
			// Unknown kind → raw value as label, a row not a raised miss (silent-read).
			assert.deepStrictEqual(exit.value, [{kind: "nonexistent-kind", label: "nonexistent-kind"}]);
		}
	}),
);

// --- tagSource.byIds: membership-stability (ADR 0016) -----------------------

it.effect("tagSource.byIds is membership-stable: a reordered kind set yields the same rows", () =>
	Effect.gen(function* () {
		const forward = yield* tagByIds(["göster", "soru", "meta"]);
		const reversed = yield* tagByIds(["meta", "soru", "göster"]);
		// Rows are a function of the kind SET, not its order — sorting both by kind
		// must collapse them to the same rows.
		const byKey = (rows: ReadonlyArray<{kind: string}>) =>
			[...rows].sort((a, b) => a.kind.localeCompare(b.kind));
		assert.deepStrictEqual(byKey(forward), byKey(reversed));
	}),
);
