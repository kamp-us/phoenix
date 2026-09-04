import {describe, expect, it} from "vitest";
import {consoleRegistry} from "../app-modules";
import {selectActiveModule} from "../module-registry";

describe("email-delivery module registration", () => {
	it("self-registers an `e-posta-teslimati` module with its nav label key", () => {
		const module = consoleRegistry.list().find((m) => m.id === "e-posta-teslimati");
		expect(module).toBeDefined();
		expect(module?.labelKey).toBe("admin.module.emailDelivery");
	});

	it("is selectable as the active module (the shell renders its panel)", () => {
		expect(selectActiveModule(consoleRegistry.list(), "e-posta-teslimati")?.id).toBe(
			"e-posta-teslimati",
		);
	});
});
