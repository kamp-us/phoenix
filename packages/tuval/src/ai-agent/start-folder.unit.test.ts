import {describe, expect, it} from "@effect/vitest";
import {Option} from "effect";
import {startFolder} from "./start-folder.ts";

/**
 * The other three arms of the precedence — the row's own folder, the spawner's, and none — are
 * proven on a real spawn in `./takes-folder-at-start.unit.test.ts`. This one is not: no spawn there
 * carries both a picked session and a spawner folder.
 */
describe("the folder a fresh session starts in (#9694)", () => {
	it("is the folder of the session the spawner named, over everything else", () => {
		expect(
			startFolder({
				opening: Option.some("/picked"),
				row: "/row",
				inherited: Option.some("/spawner"),
			}),
		).toEqual(Option.some("/picked"));
	});
});
