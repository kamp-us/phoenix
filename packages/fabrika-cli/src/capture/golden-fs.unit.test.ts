/**
 * The golden-pointer fs boundary: a missing file is an empty pointer, a malformed
 * entry fails loud, and serialize→load round-trips with sorted, stable output.
 */
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {loadGoldenPointer, serializeGoldenPointer} from "./golden-fs.ts";
import type {GoldenPointer} from "./golden-pointer.ts";

const tmpFile = (name: string, contents?: string): string => {
	const dir = mkdtempSync(join(tmpdir(), "golden-fs-"));
	const path = join(dir, name);
	if (contents !== undefined) writeFileSync(path, contents);
	return path;
};

describe("loadGoldenPointer", () => {
	it("treats a missing file as an empty pointer (the pre-bless state)", () => {
		assert.deepStrictEqual(loadGoldenPointer(join(tmpdir(), "does-not-exist-golden.json")), {});
	});

	it("reads a well-formed pointer file", () => {
		const path = tmpFile(
			"golden-pointer.json",
			JSON.stringify({
				surfaces: {"/sozluk": {sha256: "a".repeat(64), blessedDate: "2026-07-14", intent: "home"}},
			}),
		);
		assert.deepStrictEqual(loadGoldenPointer(path), {
			"/sozluk": {sha256: "a".repeat(64), blessedDate: "2026-07-14", intent: "home"},
		});
	});

	it("fails loud on a malformed entry (never a half-filled pointer a resolve mis-reads)", () => {
		const path = tmpFile("golden-pointer.json", JSON.stringify({surfaces: {"/x": {sha256: 123}}}));
		assert.throws(() => loadGoldenPointer(path), /malformed/);
	});
});

describe("serializeGoldenPointer", () => {
	it("sorts surface-ids and round-trips through load", () => {
		const pointer: GoldenPointer = {
			"/sozluk:empty": {sha256: "b".repeat(64), blessedDate: "2026-07-14", intent: "empty"},
			"/sozluk": {sha256: "a".repeat(64), blessedDate: "2026-07-14", intent: "home"},
		};
		const serialized = serializeGoldenPointer(pointer);
		// sorted: "/sozluk" appears before "/sozluk:empty"
		assert.isBelow(serialized.indexOf('"/sozluk"'), serialized.indexOf('"/sozluk:empty"'));
		assert.isTrue(serialized.endsWith("\n"));
		const path = tmpFile("golden-pointer.json", serialized);
		assert.deepStrictEqual(loadGoldenPointer(path), pointer);
	});
});
