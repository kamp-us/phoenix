import {Effect, Redacted} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type Scripted} from "../fakes.test-support.ts";
import {getRepoVariable} from "./variables.ts";

const VARIABLE = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/actions\/variables\/SOME_NAME$/;
// A dummy value: nothing here is a real login.
const VALUE = "v".repeat(32);

const run = (script: ReadonlyArray<Scripted>) =>
	Effect.runPromise(Effect.provide(getRepoVariable("o/r", "SOME_NAME"), fakeSeams(script).layer));

describe("getRepoVariable", () => {
	it("answers the variable's value redacted, so printing the answer prints no value", async () => {
		const read = await run([
			[VARIABLE, {status: 200, body: JSON.stringify({name: "SOME_NAME", value: VALUE})}],
		]);
		expect(read._tag).toBe("Present");
		if (read._tag !== "Present") return;
		expect(Redacted.value(read.value)).toBe(VALUE);
		expect(JSON.stringify(read)).not.toContain(VALUE);
	});

	it("answers a 404 as absent: nobody has set the variable", async () => {
		expect(await run([[VARIABLE, {status: 404, body: '{"message":"Not Found"}'}]])).toEqual({
			_tag: "Absent",
		});
	});

	/** A token that may not read variables is "you may not look", never "nobody set it". */
	it("answers a 403 as unknown, never as absent", async () => {
		const read = await run([
			[VARIABLE, {status: 403, body: '{"message":"Resource not accessible"}'}],
		]);
		expect(read._tag).toBe("Unknown");
	});

	it("answers a 200 carrying no value as unknown", async () => {
		const read = await run([[VARIABLE, {status: 200, body: JSON.stringify({name: "SOME_NAME"})}]]);
		expect(read._tag).toBe("Unknown");
	});
});
