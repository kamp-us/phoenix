import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, assert, describe, it} from "vitest";
import {indexSessionFiles} from "../src/backend/session-file-index.js";

const temporaryRoots: Array<string> = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, {recursive: true, force: true})),
	);
});

describe("recursive Pi session file index", () => {
	it("finds nested JSONL files while refusing symlink escapes", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-session-index-"));
		const outside = await mkdtemp(join(tmpdir(), "tuval-session-index-outside-"));
		temporaryRoots.push(root, outside);
		const nested = join(root, "project", "parent", "forks", "nested.jsonl");
		await mkdir(join(root, "project", "parent", "forks"), {recursive: true});
		await writeFile(nested, "{}\n");
		await writeFile(join(outside, "escaped.jsonl"), "{}\n");
		await symlink(outside, join(root, "project", "outside"));

		const indexed = await indexSessionFiles(root);
		const canonicalRoot = await realpath(root);
		assert.deepEqual(indexed.files, [
			join(canonicalRoot, "project", "parent", "forks", "nested.jsonl"),
		]);
		assert.ok(indexed.files.every((path) => path.startsWith(canonicalRoot)));
	});

	it("reports traversal bounds instead of descending indefinitely", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-session-index-bounds-"));
		temporaryRoots.push(root);
		const shallow = join(root, "project", "shallow.jsonl");
		const deep = join(root, "project", "parent", "forks", "deep.jsonl");
		await mkdir(join(root, "project", "parent", "forks"), {recursive: true});
		await writeFile(shallow, "{}\n");
		await writeFile(deep, "{}\n");

		const indexed = await indexSessionFiles(root, {maxDepth: 1});
		const canonicalRoot = await realpath(root);
		assert.deepEqual(indexed.files, [join(canonicalRoot, "project", "shallow.jsonl")]);
		assert.ok(indexed.problems.some(({message}) => message.includes("depth limit 1")));

		const entryBounded = await indexSessionFiles(root, {maxEntries: 1});
		assert.ok(entryBounded.problems.some(({message}) => message.includes("entry limit 1")));
	});
});
