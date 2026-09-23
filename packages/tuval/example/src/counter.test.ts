import {emit, testProgram} from "@kampus/tuval-sdk/authoring";
import {expect, test} from "vitest";
import {counter} from "./counter.js";

test("adds what arrives on the add port", () => {
	const run = testProgram(counter).send("add", 2).send("add", 3);
	expect(run.state).toEqual({total: 5});
	expect(run.effects).toContainEqual(emit("total", 5));
});

test("refuses a payload the port's schema rejects", () => {
	expect(() => testProgram(counter).send("add", "two")).toThrow();
});
