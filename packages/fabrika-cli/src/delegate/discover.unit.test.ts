import {Effect, Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {ancestors, discoverRepoLocalInstall} from "./discover.ts";

const MANIFEST = JSON.stringify({
	name: "@kampus/fabrika-cli",
	bin: {"fabrika-cli": "./dist/bin.js"},
});

const nodePath = await Effect.runPromise(Path.Path.pipe(Effect.provide(Path.layer)));

const run = (options: Parameters<typeof fakeFs>[0], from: string) =>
	Effect.runPromiseExit(discoverRepoLocalInstall(from).pipe(Effect.provide(fakeFs(options).layer)));

describe("ancestors", () => {
	it("is the directory then every parent, nearest first, ending at the root", () => {
		expect(ancestors(nodePath, "/a/b/c")).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
	});
});

describe("discoverRepoLocalInstall", () => {
	it("finds the install above the cwd and resolves its declared bin to an absolute path", async () => {
		const exit = await run(
			{files: {"/repo/node_modules/@kampus/fabrika-cli/package.json": MANIFEST}},
			"/repo/apps/web",
		);
		expect(exit._tag).toBe("Success");
		expect(exit._tag === "Success" ? exit.value : undefined).toEqual({
			packageRoot: "/repo/node_modules/@kampus/fabrika-cli",
			manifestPath: "/repo/node_modules/@kampus/fabrika-cli/package.json",
			binPath: "/repo/node_modules/@kampus/fabrika-cli/dist/bin.js",
		});
	});

	it("takes the NEAREST install, not the outermost one", async () => {
		const exit = await run(
			{
				files: {
					"/repo/node_modules/@kampus/fabrika-cli/package.json": MANIFEST,
					"/repo/apps/web/node_modules/@kampus/fabrika-cli/package.json": MANIFEST,
				},
			},
			"/repo/apps/web",
		);
		expect(exit._tag === "Success" ? exit.value?.packageRoot : undefined).toBe(
			"/repo/apps/web/node_modules/@kampus/fabrika-cli",
		);
	});

	it("reports the install's REAL path, so a pnpm workspace link cannot delegate to itself", async () => {
		const exit = await run(
			{
				files: {"/repo/node_modules/@kampus/fabrika-cli/package.json": MANIFEST},
				real: {"/repo/node_modules/@kampus/fabrika-cli": "/repo/packages/fabrika-cli"},
			},
			"/repo",
		);
		expect(exit._tag === "Success" ? exit.value : undefined).toMatchObject({
			packageRoot: "/repo/packages/fabrika-cli",
			binPath: "/repo/packages/fabrika-cli/dist/bin.js",
		});
	});

	it("answers `undefined` — a proven absence — when no ancestor holds the package", async () => {
		const exit = await run({files: {}}, "/somewhere/else");
		expect(exit._tag === "Success" ? exit.value : "not-run").toBeUndefined();
	});

	it("FAILS rather than answering absent when an ancestor cannot be probed", async () => {
		const exit = await run(
			{files: {}, unprobeable: ["/repo/node_modules/@kampus/fabrika-cli/package.json"]},
			"/repo/apps",
		);
		expect(exit._tag).toBe("Failure");
	});

	it("FAILS on a manifest that declares no fabrika-cli bin — never falls through to the global", async () => {
		const exit = await run(
			{
				files: {
					"/repo/node_modules/@kampus/fabrika-cli/package.json": JSON.stringify({name: "x"}),
				},
			},
			"/repo",
		);
		expect(exit._tag).toBe("Failure");
	});

	it("accepts the single-string `bin` form", async () => {
		const exit = await run(
			{
				files: {
					"/repo/node_modules/@kampus/fabrika-cli/package.json": JSON.stringify({
						bin: "./bin.js",
					}),
				},
			},
			"/repo",
		);
		expect(exit._tag === "Success" ? exit.value?.binPath : undefined).toBe(
			"/repo/node_modules/@kampus/fabrika-cli/bin.js",
		);
	});
});
