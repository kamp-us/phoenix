/**
 * Loads a project's config twice in one real Node process, with one file rewritten between the
 * loads, and prints what each load read as one JSON line. `./module-generations.unit.test.ts` runs
 * it as a child: Vitest imports modules through its own runner, so the Node module cache and the
 * `resolve` hook that stamps past it are only in play in a plain `node` process.
 *
 *   node src/module-generations.probe.ts <project> <file-to-rewrite> <new-contents>
 */

import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {Effect} from "effect";
import {loadLayeredConfig} from "./config.ts";

const [project, edited, contents] = process.argv.slice(2);
if (project === undefined || edited === undefined || contents === undefined) {
	throw new Error("usage: module-generations.probe.ts <project> <file-to-rewrite> <new-contents>");
}

const read = loadLayeredConfig({
	global: join(project, "no-global-layer.ts"),
	project: join(project, ".tuval", "tuval.config.ts"),
}).pipe(
	Effect.map((config) => ({
		ids: config.programs.map((row) => (row as {readonly id: string}).id),
		files: config.files,
	})),
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
