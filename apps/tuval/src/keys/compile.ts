/**
 * Every owner's key sources compiled against the registered spells, for the key scopes the shell
 * routes through (#9687). Apart from `./scopes.ts` because compiling reads the SDK's parser and
 * schemas, and the scopes are on the shell core's import path, which the page loads.
 */

import {
	type BindingError,
	type BindingSource,
	compileBindings,
} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
import type {RegistryTable} from "@kampus/tuval-sdk/kernel/commands/registry";
import {Effect} from "effect";
import type {OwnerBindings} from "./scopes.ts";

/** One owner's key sources, as the config generation keeps them apart. */
export interface OwnerKeys {
	readonly global: ReadonlyArray<BindingSource>;
	readonly projects: ReadonlyArray<{
		readonly key: string;
		readonly sources: ReadonlyArray<BindingSource>;
	}>;
}

/** In layer order, so the errors read in the order the sources do. */
const compileAll = (sources: ReadonlyArray<BindingSource>, table: RegistryTable) =>
	Effect.map(
		Effect.forEach(sources, (source) => compileBindings(source, table), {concurrency: 1}),
		(compiled) => ({
			bindings: compiled.flatMap((one) => one.bindings),
			errors: compiled.flatMap((one) => one.errors),
		}),
	);

/**
 * Every owner's bindings compiled against `table`, kept apart for the key scopes they route
 * through. A binding that does not compile costs its own key, as `compileBindings` rules, and is
 * answered beside them.
 */
export const compileOwnerBindings = Effect.fn("Tuval.compileOwnerBindings")(function* (
	owners: OwnerKeys,
	table: RegistryTable,
) {
	const global = yield* compileAll(owners.global, table);
	const projects = yield* Effect.forEach(
		owners.projects,
		(project) =>
			Effect.map(compileAll(project.sources, table), (compiled) => ({key: project.key, compiled})),
		{concurrency: 1},
	);
	const errors: ReadonlyArray<BindingError> = [
		...global.errors,
		...projects.flatMap((project) => project.compiled.errors),
	];
	const bindings: OwnerBindings = {
		global: global.bindings,
		projects: new Map(projects.map((project) => [project.key, project.compiled.bindings])),
	};
	return {bindings, errors};
});
