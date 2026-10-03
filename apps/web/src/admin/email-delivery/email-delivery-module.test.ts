import {describe, expect, it} from "vitest";
import {consoleRegistry} from "../app-modules";

describe("email-delivery module registration", () => {
	it("self-registers an `e-posta-teslimati` module with its nav label key", () => {
		const module = consoleRegistry.list().find((m) => m.id === "e-posta-teslimati");
		expect(module).toBeDefined();
		expect(module?.labelKey).toBe("admin.module.emailDelivery");
	});
});
