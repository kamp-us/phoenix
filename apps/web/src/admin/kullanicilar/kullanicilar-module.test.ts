/**
 * The kullanıcılar module registers into the admin-console shell (#3200): importing the
 * app-wide composition self-registers the `kullanicilar` module as a nav entry with a
 * Turkish label, and the shell's pure `selectActiveModule` resolves it — asserted DOM-free
 * (the panel chunk is `React.lazy`, never evaluated here). Mirrors
 * `email-delivery-module.test.ts`; proves the console module contract (#2740) for this tenant.
 */
import {describe, expect, it} from "vitest";
import {consoleRegistry} from "../app-modules";
import {selectActiveModule} from "../module-registry";

describe("kullanicilar module registration", () => {
	it("self-registers a `kullanicilar` module with a Turkish nav label", () => {
		const module = consoleRegistry.list().find((m) => m.id === "kullanicilar");
		expect(module).toBeDefined();
		expect(module?.label).toBe("kullanıcılar");
	});

	it("is selectable as the active module (the shell renders its panel)", () => {
		expect(selectActiveModule(consoleRegistry.list(), "kullanicilar")?.id).toBe("kullanicilar");
	});
});
