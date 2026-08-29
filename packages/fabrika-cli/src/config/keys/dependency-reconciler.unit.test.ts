import {describe, expect, it} from "vitest";
import {dependencyReconcilerKey, SHIPPED_DEPENDENCY_RECONCILER} from "./dependency-reconciler.ts";

const decode = (raw: unknown) => dependencyReconcilerKey.decode(raw);

describe("dependencyReconciler", () => {
	it("decodes a declared install to the argv the verb spawns", () => {
		expect(decode({command: ["pnpm", "install", "--frozen-lockfile"]})).toEqual({
			_tag: "Value",
			value: {argv: ["pnpm", "install", "--frozen-lockfile"]},
		});
	});

	it("reads an explicit null as `this repo has no install to run`", () => {
		expect(decode(null)).toEqual({_tag: "Value", value: null});
	});

	it("ships nothing declared, so an absent key runs no install", () => {
		expect(SHIPPED_DEPENDENCY_RECONCILER).toBe(null);
	});

	for (const raw of [{}, {command: []}, {command: "pnpm install"}, {command: ["  "]}, [], "pnpm"]) {
		it(`refuses ${JSON.stringify(raw)} whole rather than spawning part of it`, () => {
			expect(decode(raw)._tag).toBe("Malformed");
		});
	}

	it("renders back the shape a repo writes, not the shape the verb holds", () => {
		expect(dependencyReconcilerKey.render?.({argv: ["pnpm", "install"]})).toEqual({
			command: ["pnpm", "install"],
		});
		expect(dependencyReconcilerKey.render?.(null)).toBe(null);
	});
});
