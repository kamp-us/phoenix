import {describe, expect, it} from "vitest";
import {consoleRegistry} from "../app-modules";

describe("kullanicilar module registration", () => {
	it("self-registers a `kullanicilar` module with its nav label key", () => {
		const module = consoleRegistry.list().find((m) => m.id === "kullanicilar");
		expect(module).toBeDefined();
		expect(module?.labelKey).toBe("admin.module.kullanicilar");
	});
});
