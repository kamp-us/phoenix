import {describe, expect, it} from "vitest";
import {findRootDir} from "./find-root-dir.ts";

describe("findRootDir", () => {
	const dirname = (p: string) => (p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");

	it("walks up to the first marker-bearing ancestor", () => {
		const markers = new Set(["/repo"]);
		expect(findRootDir("/repo/packages/x", (d) => markers.has(d), dirname)).toBe("/repo");
	});

	it("returns null when no marker is found before the fs root", () => {
		expect(findRootDir("/a/b/c", () => false, dirname)).toBeNull();
	});
});
