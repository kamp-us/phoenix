import {describe, expect, it} from "vitest";
import {DECLARED_FLAGS, MEMBER_MUTE} from "../../flags/keys";
import {consoleRegistry} from "../app-modules";

describe("flags module registration", () => {
	it("self-registers a `bayraklar` module with its nav label key", () => {
		const module = consoleRegistry.list().find((m) => m.id === "bayraklar");
		expect(module).toBeDefined();
		expect(module?.labelKey).toBe("admin.module.flags");
	});

	it("enumerates every declared key exactly once", () => {
		const keys = DECLARED_FLAGS.map((f) => f.key);
		expect(keys).toContain(MEMBER_MUTE);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
