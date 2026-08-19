/**
 * The pano fate loader seam. Only `tagSource.byIds` is covered: `Tag` has no table, so
 * its kind→label map IS the whole fetch, while `postSource`/`commentSource` are pure
 * pass-throughs their service tests already cover.
 */

import {it} from "@effect/vitest";
import {Effect} from "effect";
import {assert} from "vitest";
import {tagSource} from "./sources.ts";

const required = <T>(value: T | undefined): T => {
	if (value === undefined) {
		throw new Error("expected the handler to be present");
	}
	return value;
};

const tagByIds = required(tagSource.handlers.byIds);

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
		const rows = yield* tagByIds(["show"]);
		assert.deepStrictEqual(rows, [{kind: "show", label: "göster"}]);
	}),
);

it.effect("tagSource.byIds is silent on an unknown kind: it falls back to the raw value", () =>
	Effect.gen(function* () {
		const exit = yield* tagByIds(["nonexistent-kind"]).pipe(Effect.exit);
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") {
			assert.deepStrictEqual(exit.value, [{kind: "nonexistent-kind", label: "nonexistent-kind"}]);
		}
	}),
);

it.effect("tagSource.byIds is membership-stable: a reordered kind set yields the same rows", () =>
	Effect.gen(function* () {
		const forward = yield* tagByIds(["göster", "soru", "meta"]);
		const reversed = yield* tagByIds(["meta", "soru", "göster"]);
		const byKey = (rows: ReadonlyArray<{kind: string}>) =>
			[...rows].sort((a, b) => a.kind.localeCompare(b.kind));
		assert.deepStrictEqual(byKey(forward), byKey(reversed));
	}),
);
