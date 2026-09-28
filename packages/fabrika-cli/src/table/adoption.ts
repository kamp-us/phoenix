/**
 * Whether a repository adopted the table: its `.fabrika.jsonc` declares a `table` block.
 *
 * It decides what a failed table read means to a verb that only consults the table, like the size
 * stop in `lane brief` and the bet order in `build pick`. Not adopted, nothing says a table exists,
 * so no read failure — a missing `project` scope, a rate limit, an outage, a forbidden token, a
 * malformed record — may add a refusal the verb did not have before tables: it goes on unread, and
 * says what it could not read. Adopted, the table is something the repository asked for, so a read
 * that failed is UNKNOWN and the verb refuses — except a missing `project` scope. That is no real
 * failure, only a token nobody refreshed, so the verb goes on unread and names the fix.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 * @ruling https://github.com/kamp-us/phoenix/issues/10135
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {Resolution} from "../config/key-group.ts";
import {type TableSettings, tableKey} from "../config/keys/table.ts";
import {resolve} from "../config/load.ts";
import {loadRepoConfig} from "../config/working-root.ts";
import type {ProjectsAnswer} from "../io/projects.ts";

export type Adoption =
	| {readonly _tag: "Adopted"; readonly settings: TableSettings}
	/** No `table` block: the settings are the shipped defaults. */
	| {readonly _tag: "Unadopted"; readonly settings: TableSettings}
	/** The config could not say, so whether a failed read may pass is UNKNOWN too. */
	| {readonly _tag: "Unknown"; readonly reason: string};

export type Known = Exclude<Adoption, {readonly _tag: "Unknown"}>;

/** Why a table read failed: the token lacks the `project` scope, or anything else. */
export type ReadFailure = Exclude<ProjectsAnswer<never>, {readonly _tag: "Ok"}>;

/** Why a verb may go on past a table it could not read. */
export type Excuse = "Unadopted" | "MissingScope";

/** What a table read that failed means under an adoption. */
export type FailedRead =
	| {readonly _tag: "Unknown"; readonly reason: string}
	/** The table could not be read and `excuse` says why the verb goes on without it. */
	| {readonly _tag: "Unread"; readonly reason: string; readonly excuse: Excuse};

export const adoptionOf = (config: Resolution<TableSettings>): Adoption => {
	switch (config._tag) {
		case "Declared":
			return {_tag: "Adopted", settings: config.value};
		case "Default":
			return {_tag: "Unadopted", settings: config.value};
		case "Malformed":
		case "Unknown":
			return {_tag: "Unknown", reason: `the \`table\` config: ${config.reason}`};
	}
};

export const failedRead = (adoption: Known, failure: ReadFailure): FailedRead => {
	if (adoption._tag === "Unadopted") {
		return {_tag: "Unread", reason: failure.reason, excuse: "Unadopted"};
	}
	return failure._tag === "MissingScope"
		? {_tag: "Unread", reason: failure.reason, excuse: "MissingScope"}
		: {_tag: "Unknown", reason: failure.reason};
};

/** The clause a verb prints after an unread table's reason, saying why it went on anyway. */
export const excuseText = (excuse: Excuse): string =>
	excuse === "Unadopted"
		? ".fabrika.jsonc declares no `table` block, so none is required"
		: "a missing `project` scope skips the table rather than refusing";

export const readAdoption = (
	cwd: string,
): Effect.Effect<Adoption, never, FileSystem.FileSystem | Path.Path> =>
	Effect.map(loadRepoConfig(cwd), (load) => adoptionOf(resolve(load, tableKey)));
