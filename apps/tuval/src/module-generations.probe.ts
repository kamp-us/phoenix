/**
 * Loads a project's config twice in one real Node process, with one file rewritten between the
 * loads, and prints what each load read as one JSON line; a refused load prints its reason and the
 * files it read. `./module-generations.unit.test.ts` runs it as a child: Vitest imports modules
 * through its own runner, so the Node module cache and the `resolve` hook that stamps past it are
 * only in play in a plain `node` process.
 *
 *   node src/module-generations.probe.ts <project> <file-to-rewrite> <new-contents>
 */

import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {localId} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
import {Effect} from "effect";
import {loadLayeredConfig} from "./config.ts";
import {noDesk} from "./config-fixtures/desk-layers.ts";
import {ProjectId} from "./project-id.ts";

const [project, edited, contents] = process.argv.slice(2);
if (project === undefined || edited === undefined || contents === undefined) {
	throw new Error("usage: module-generations.probe.ts <project> <file-to-rewrite> <new-contents>");
}

const read = loadLayeredConfig({
	desk: noDesk,
	global: join(project, "no-global-layer.ts"),
	project: {id: ProjectId.of(project), module: join(project, ".tuval", "tuval.config.ts")},
}).pipe(
	Effect.match({
		onSuccess: (config) => ({
			// Local ids: the probe's project layer scopes its rows (#9684), and the question here is
			// which generation of the module was read, not which scope it runs under.
			ids: config.programs.map((row) => localId((row as {readonly id: string}).id)),
			files: config.files,
		}),
		onFailure: (refused) => ({refused: refused.reason, files: refused.files}),
	}),
);

const probe = Effect.gen(function* () {
	const before = yield* read;
	writeFileSync(edited, contents);
	const after = yield* read;
	return {before, after};
});

console.log(
	JSON.stringify(await Effect.runPromise(probe.pipe(Effect.provide(NodeFileSystem.layer)))),
);
