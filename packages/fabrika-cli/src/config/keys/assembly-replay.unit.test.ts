/**
 * `assemblyReplay` — the shipped surface is today's refusal, and a value nobody meant is refused
 * rather than rounded to one.
 */
import {describe, expect, it} from "vitest";
import {assemblyReplayKey, SHIPPED_ASSEMBLY_REPLAY} from "./assembly-replay.ts";

describe("the assemblyReplay key", () => {
	it("ships off, so a repo declaring nothing keeps the collision refusal it has today", () => {
		expect(SHIPPED_ASSEMBLY_REPLAY).toEqual({onCollision: "off", lockfileRegenerator: null});
		expect(assemblyReplayKey.shippedDefault).toEqual(SHIPPED_ASSEMBLY_REPLAY);
	});

	it.each(["off", "on"])("decodes the declared %s", (onCollision) => {
		expect(assemblyReplayKey.decode({onCollision})).toEqual({
			_tag: "Value",
			value: {onCollision, lockfileRegenerator: null},
		});
	});

	it("falls to the shipped value for an object that declares no sub-key", () => {
		expect(assemblyReplayKey.decode({})).toEqual({
			_tag: "Value",
			value: SHIPPED_ASSEMBLY_REPLAY,
		});
	});

	it.each([
		["a value outside the two arms", {onCollision: "sometimes"}],
		["a boolean where a token belongs", {onCollision: true}],
		["a sub-key nobody reads", {onColision: "on"}],
		["a scalar where the surface belongs", "on"],
		["an array where the surface belongs", ["on"]],
	])("refuses %s rather than rounding it to a default", (_case, raw) => {
		expect(assemblyReplayKey.decode(raw)._tag).toBe("Malformed");
	});
});

describe("the assemblyReplay lockfileRegenerator", () => {
	it("decodes a declared regenerator to the argv the replay spawns and the lockfiles it owns", () => {
		expect(
			assemblyReplayKey.decode({
				onCollision: "on",
				lockfileRegenerator: {
					command: ["pnpm", "install", "--lockfile-only"],
					lockfiles: ["pnpm-lock.yaml"],
				},
			}),
		).toEqual({
			_tag: "Value",
			value: {
				onCollision: "on",
				lockfileRegenerator: {
					argv: ["pnpm", "install", "--lockfile-only"],
					lockfiles: ["pnpm-lock.yaml"],
				},
			},
		});
	});

	it("ships none, and reads an explicit null as none, so a lockfile collision still parks", () => {
		expect(SHIPPED_ASSEMBLY_REPLAY.lockfileRegenerator).toBe(null);
		expect(assemblyReplayKey.decode({onCollision: "on"})).toEqual({
			_tag: "Value",
			value: {onCollision: "on", lockfileRegenerator: null},
		});
		expect(assemblyReplayKey.decode({lockfileRegenerator: null})).toEqual({
			_tag: "Value",
			value: SHIPPED_ASSEMBLY_REPLAY,
		});
	});

	it.each([
		["no command", {lockfiles: ["pnpm-lock.yaml"]}],
		["no lockfiles", {command: ["pnpm", "install", "--lockfile-only"]}],
		["an empty command", {command: [], lockfiles: ["pnpm-lock.yaml"]}],
		["an empty lockfile list", {command: ["pnpm", "install"], lockfiles: []}],
		["a command as one string", {command: "pnpm install", lockfiles: ["pnpm-lock.yaml"]}],
		["a blank lockfile", {command: ["pnpm", "install"], lockfiles: ["  "]}],
		["a field nobody reads", {command: ["pnpm"], lockfiles: ["pnpm-lock.yaml"], cwd: "."}],
		["an array", [["pnpm", "install"]]],
	])("refuses %s whole rather than spawning part of it", (_case, lockfileRegenerator) => {
		expect(assemblyReplayKey.decode({lockfileRegenerator})._tag).toBe("Malformed");
	});

	it("renders back the shape a repo writes, not the shape the replay holds", () => {
		expect(
			assemblyReplayKey.render?.({
				onCollision: "on",
				lockfileRegenerator: {argv: ["pnpm", "install"], lockfiles: ["pnpm-lock.yaml"]},
			}),
		).toEqual({
			onCollision: "on",
			lockfileRegenerator: {command: ["pnpm", "install"], lockfiles: ["pnpm-lock.yaml"]},
		});
		expect(assemblyReplayKey.render?.(SHIPPED_ASSEMBLY_REPLAY)).toEqual(SHIPPED_ASSEMBLY_REPLAY);
	});
});
