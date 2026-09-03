import {fileURLToPath} from "node:url";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {ConfigLoadError, loadConfigModule} from "./config.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));

const refusal = async (name: string): Promise<ConfigLoadError> => {
	const error = await Effect.runPromise(Effect.flip(loadConfigModule(fixture(name))));
	expect(error).toBeInstanceOf(ConfigLoadError);
	return error;
};

describe("loadConfigModule", () => {
	it("returns the rows a well-formed module default-exports, and an empty graph when it exports none", async () => {
		const config = await Effect.runPromise(loadConfigModule(fixture("two-rows")));
		expect(config).toEqual({programs: [{id: "a"}, {id: "b"}], graph: {nodes: []}});
	});

	it("returns the graph a module exports beside its rows", async () => {
		const config = await Effect.runPromise(loadConfigModule(fixture("with-graph")));
		expect(config).toEqual({
			programs: [{id: "a"}],
			graph: {nodes: [{id: "n", program: "a", on: []}]},
		});
	});

	it("refuses a graph export that is not a graph, naming the shape it got", async () => {
		const error = await refusal("bad-graph");
		expect(error.reason).toBe("graph export is not a graph; export a {nodes: [...]} (got number)");
	});

	it("refuses a module that throws, naming the module and the thrown reason", async () => {
		const error = await refusal("throws");
		expect(error.module).toBe(fixture("throws"));
		expect(error.reason).toBe("module threw while loading: boom at import time");
		expect(error.message).toBe(
			`config module ${fixture("throws")}: module threw while loading: boom at import time`,
		);
	});

	it("refuses a default export that is not a list, naming the shape it got", async () => {
		const error = await refusal("wrong-shape");
		expect(error.module).toBe(fixture("wrong-shape"));
		expect(error.reason).toBe("default export is not a list of program rows (got object)");
	});

	it("refuses a module with no default export", async () => {
		const error = await refusal("no-default");
		expect(error.module).toBe(fixture("no-default"));
		expect(error.reason).toBe("no default export; export default the list of program rows");
	});
});
