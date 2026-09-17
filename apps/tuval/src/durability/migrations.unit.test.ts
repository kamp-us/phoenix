/**
 * The walk itself, away from any kernel: what it covers, and every way it refuses. The refusals are
 * the half worth pinning — the ruling on #8907 admitted the migration and moved nothing else, so a
 * version this cannot reach the current one from is still a refused boot.
 */

import {assert, describe, it} from "@effect/vitest";
import {Option} from "effect";
import type {Migrations} from "../registry/program.ts";
import {migrateState} from "./migrations.ts";

const fill = (field: string, value: unknown) => (raw: unknown) =>
	Option.some({...(raw as Record<string, unknown>), [field]: value});

const chain: Migrations = {
	"1.0.0": {to: "1.1.0", migrate: fill("inspectorOpen", false)},
	"1.1.0": {to: "1.2.0", migrate: fill("boardOpen", false)},
};

describe("migrateState", () => {
	it("walks every declared step between the version on disk and the program's own", () => {
		const walked = migrateState(chain, "1.0.0", "1.2.0", {windows: 2});
		assert.deepStrictEqual(
			walked,
			Option.some({windows: 2, inspectorOpen: false, boardOpen: false}),
		);
	});

	it("answers the state untouched when the version on disk is already the program's", () => {
		assert.deepStrictEqual(
			migrateState(chain, "1.2.0", "1.2.0", {windows: 2}),
			Option.some({windows: 2}),
		);
	});

	it("refuses a version no step leaves, including a program that declares none at all", () => {
		assert.deepStrictEqual(migrateState(chain, "0.9.0", "1.2.0", {}), Option.none());
		assert.deepStrictEqual(migrateState(undefined, "1.1.0", "1.2.0", {}), Option.none());
	});

	it("refuses a chain left behind by a later bump rather than mislabelling where it stopped", () => {
		assert.deepStrictEqual(migrateState(chain, "1.0.0", "1.3.0", {windows: 2}), Option.none());
	});

	it("refuses bytes a step declined", () => {
		const declines: Migrations = {"1.1.0": {to: "1.2.0", migrate: () => Option.none()}};
		assert.deepStrictEqual(migrateState(declines, "1.1.0", "1.2.0", "not a state"), Option.none());
	});

	it("refuses a cycle instead of walking it forever", () => {
		const loop: Migrations = {
			"1.0.0": {to: "1.1.0", migrate: (raw) => Option.some(raw)},
			"1.1.0": {to: "1.0.0", migrate: (raw) => Option.some(raw)},
		};
		assert.deepStrictEqual(migrateState(loop, "1.0.0", "2.0.0", {}), Option.none());
	});
});
