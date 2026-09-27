import {mkdirSync, mkdtempSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {FolderUnreadable, listFolders} from "./browse.ts";

const tree = (): string => {
	const root = mkdtempSync(join(tmpdir(), "tuval-browse-"));
	for (const name of ["zeta", "Alpha", "beta10", "beta9", ".hidden"]) mkdirSync(join(root, name));
	mkdirSync(join(root, "Alpha", ".tuval"));
	writeFileSync(join(root, "Alpha", ".tuval", "tuval.config.ts"), "export default {}\n");
	writeFileSync(join(root, "notes.txt"), "not a folder\n");
	symlinkSync(join(root, "gone"), join(root, "dangling"));
	return root;
};

describe("listFolders", () => {
	it.effect("lists only visible folders, by name as a person reads them, marking a config", () =>
		Effect.gen(function* () {
			const root = tree();
			const listing = yield* listFolders(root, (folder) => folder === join(root, "zeta"));
			assert.deepStrictEqual(
				listing.folders.map(({name, hasConfig, open}) => ({name, hasConfig, open})),
				[
					{name: "Alpha", hasConfig: true, open: false},
					{name: "beta9", hasConfig: false, open: false},
					{name: "beta10", hasConfig: false, open: false},
					{name: "zeta", hasConfig: false, open: true},
				],
			);
			assert.strictEqual(listing.folders[0]?.folder, join(root, "Alpha"));
			assert.deepStrictEqual(listing.parent?.folder, tmpdir().replace(/\/$/, ""));
			assert.isFalse(listing.open);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("names no parent at the root of the file system", () =>
		Effect.gen(function* () {
			const listing = yield* listFolders("/", () => false);
			assert.isNull(listing.parent);
			assert.strictEqual(listing.name, "/");
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("refuses a path that is not a folder, or not there", () =>
		Effect.gen(function* () {
			const root = tree();
			const file = yield* Effect.flip(listFolders(join(root, "notes.txt"), () => false));
			assert.instanceOf(file, FolderUnreadable);
			assert.strictEqual(file.reason, "it is not a folder");
			const missing = yield* Effect.flip(listFolders(join(root, "nope"), () => false));
			assert.instanceOf(missing, FolderUnreadable);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
