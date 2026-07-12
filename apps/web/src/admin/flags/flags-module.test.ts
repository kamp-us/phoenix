/**
 * The flags module registers into the admin-console shell (#2742, epic #2711): importing the
 * app-wide composition self-registers the `bayraklar` module as a nav entry with a Turkish label,
 * and the shell's pure `selectActiveModule` resolves it — asserted DOM-free (the panel chunk is
 * `React.lazy`, never evaluated here). It proves the console module contract (#2740) end-to-end.
 */
import {describe, expect, it} from "vitest";
import {DECLARED_FLAGS} from "../../flags/keys";
import {consoleRegistry} from "../app-modules";
import {selectActiveModule} from "../module-registry";

describe("flags module registration", () => {
	it("self-registers a `bayraklar` module with a Turkish nav label", () => {
		const module = consoleRegistry.list().find((m) => m.id === "bayraklar");
		expect(module).toBeDefined();
		expect(module?.label).toBe("özellik bayrakları");
	});

	it("is selectable as the active module (the shell renders its panel)", () => {
		expect(selectActiveModule(consoleRegistry.list(), "bayraklar")?.id).toBe("bayraklar");
	});

	it("enumerates the admin-console flag and every declared key exactly once", () => {
		const keys = DECLARED_FLAGS.map((f) => f.key);
		expect(keys).toContain("phoenix-admin-console");
		expect(new Set(keys).size).toBe(keys.length);
	});
});
