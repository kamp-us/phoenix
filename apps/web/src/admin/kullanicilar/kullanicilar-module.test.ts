import {describe, expect, it} from "vitest";
import {consoleRegistry} from "../app-modules";
import {selectActiveModule} from "../module-registry";

describe("kullanicilar module registration", () => {
	it("self-registers a `kullanicilar` module with its nav label key", () => {
		const module = consoleRegistry.list().find((m) => m.id === "kullanicilar");
		expect(module).toBeDefined();
		expect(module?.labelKey).toBe("admin.module.kullanicilar");
	});

	it("is selectable as the active module (the shell renders its panel)", () => {
		expect(selectActiveModule(consoleRegistry.list(), "kullanicilar")?.id).toBe("kullanicilar");
	});
});
