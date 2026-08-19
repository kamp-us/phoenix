import {lazy} from "react";
import {describe, expect, it} from "vitest";
import {type ConsoleModule, createConsoleRegistry, selectActiveModule} from "./module-registry";

function fakeModule(id: string, label = id): ConsoleModule {
	return {id, label, panel: lazy(async () => ({default: () => null}))};
}

describe("createConsoleRegistry — register by value", () => {
	it("lists registered modules in registration (nav) order", () => {
		const registry = createConsoleRegistry();
		const a = fakeModule("a");
		const b = fakeModule("b");
		registry.register(a);
		registry.register(b);
		expect(registry.list()).toEqual([a, b]);
	});

	it("rejects a duplicate id — two modules can't own one nav key", () => {
		const registry = createConsoleRegistry();
		registry.register(fakeModule("dup"));
		expect(() => registry.register(fakeModule("dup"))).toThrow(/already registered: dup/);
	});

	it("starts empty", () => {
		expect(createConsoleRegistry().list()).toEqual([]);
	});
});

describe("selectActiveModule — the shell's render decision", () => {
	const a = fakeModule("a");
	const b = fakeModule("b");

	it("selects the module matching the selected id", () => {
		expect(selectActiveModule([a, b], "b")).toBe(b);
	});

	it("falls back to the first module when nothing is selected", () => {
		expect(selectActiveModule([a, b], null)).toBe(a);
	});

	it("falls back to the first module when the selected id is unknown (never blanks)", () => {
		expect(selectActiveModule([a, b], "gone")).toBe(a);
	});

	it("returns null only when the host is empty", () => {
		expect(selectActiveModule([], "a")).toBeNull();
	});
});
