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
