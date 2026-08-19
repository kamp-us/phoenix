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
