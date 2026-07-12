/**
 * The email-delivery module registers into the admin-console shell (#2732, epic #2687):
 * importing the app-wide composition self-registers the `e-posta-teslimati` module as a nav
 * entry with a Turkish label, and the shell's pure `selectActiveModule` resolves it —
 * asserted DOM-free (the panel chunk is `React.lazy`, never evaluated here). Mirrors
 * `flags-module.test.ts`; proves the console module contract (#2740) for this tenant.
 */
import {describe, expect, it} from "vitest";
import {consoleRegistry} from "../app-modules";
import {selectActiveModule} from "../module-registry";

describe("email-delivery module registration", () => {
	it("self-registers an `e-posta-teslimati` module with a Turkish nav label", () => {
		const module = consoleRegistry.list().find((m) => m.id === "e-posta-teslimati");
		expect(module).toBeDefined();
		expect(module?.label).toBe("e-posta teslimatı");
	});

	it("is selectable as the active module (the shell renders its panel)", () => {
		expect(selectActiveModule(consoleRegistry.list(), "e-posta-teslimati")?.id).toBe(
			"e-posta-teslimati",
		);
	});
});
