import {describe, expect, it} from "@effect/vitest";
import {Option} from "effect";
import {startFolder} from "./start-folder.ts";

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

	it("is the row's own folder when the row fixes one, whatever the spawner runs in", () => {
		expect(
			startFolder({opening: Option.none(), row: "/row", inherited: Option.some("/spawner")}),
		).toEqual(Option.some("/row"));
	});

	it("is the spawner's folder for a row that takes its folder at start", () => {
		expect(
			startFolder({opening: Option.none(), row: null, inherited: Option.some("/spawner")}),
		).toEqual(Option.some("/spawner"));
	});

	it("is none when nothing names a folder", () => {
		expect(startFolder({opening: Option.none(), row: null, inherited: Option.none()})).toEqual(
			Option.none(),
		);
	});
});
