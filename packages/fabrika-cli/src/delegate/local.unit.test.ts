import {Effect, Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {takeSkipInfer} from "./entry.ts";
import {declaredVersion, isInsideRepo, readInstallManifest} from "./local.ts";
import {SKIP_INFER_ENV, SKIP_INFER_FLAG} from "./resolve.ts";

const manifest = (text: string) =>
	Effect.runSync(
		Effect.gen(function* () {
			return readInstallManifest(yield* Path.Path, "/repo/node_modules/pkg/package.json", text);
		}).pipe(Effect.provide(Path.layer)),
	);

describe("readInstallManifest", () => {
	it("resolves the bin against the manifest's own directory", () => {
		expect(manifest('{"version":"1.2.3","bin":{"fabrika":"./src/bin.ts"}}')).toEqual({
			version: "1.2.3",
			bin: "/repo/node_modules/pkg/src/bin.ts",
		});
	});

	it("accepts the string `bin` shorthand", () => {
		expect(manifest('{"version":"1.2.3","bin":"./src/bin.ts"}')).toMatchObject({version: "1.2.3"});
	});

	it("calls a manifest with no `version` corrupt — the warning needs it", () => {
		expect(manifest('{"bin":"./src/bin.ts"}')).toEqual({
			corrupt: '/repo/node_modules/pkg/package.json declares no "version"',
		});
	});

	it("calls a manifest with no fabrika bin corrupt", () => {
		expect(manifest('{"version":"1.2.3"}')).toMatchObject({
			corrupt: expect.stringContaining("bin"),
		});
	});

	it("calls unparseable JSON corrupt rather than throwing", () => {
		expect(manifest("{not json")).toMatchObject({
			corrupt: expect.stringContaining("not valid JSON"),
		});
	});
});

describe("isInsideRepo — the rule that keeps a NODE_PATH hit from posing as a local install", () => {
	const inside = (root: string, candidate: string) =>
		Effect.runSync(
			Effect.gen(function* () {
				return isInsideRepo(yield* Path.Path, root, candidate);
			}).pipe(Effect.provide(Path.layer)),
		);

	it("accepts an ordinary node_modules install", () => {
		expect(inside("/repo", "/repo/node_modules/@kampus/fabrika-cli")).toBe(true);
	});

	it("accepts pnpm's real target — a workspace package linked into node_modules", () => {
		expect(inside("/repo", "/repo/packages/fabrika-cli")).toBe(true);
	});

	it("accepts the repo root itself, for a repo that IS the package", () => {
		expect(inside("/repo", "/repo")).toBe(true);
	});

	it("rejects a copy in another checkout — the NODE_PATH case", () => {
		expect(inside("/other", "/repo/packages/fabrika-cli")).toBe(false);
	});

	it("rejects an install hoisted above the repo root", () => {
		expect(inside("/repo/inner", "/repo/node_modules/@kampus/fabrika-cli")).toBe(false);
	});

	it("is not fooled by a sibling whose name starts with the root's", () => {
		expect(inside("/repo", "/repo-two/node_modules/@kampus/fabrika-cli")).toBe(false);
	});
});

describe("declaredVersion", () => {
	const of = (files: Record<string, string>) =>
		Effect.runPromise(declaredVersion("/repo").pipe(Effect.provide(fakeFs({files}).layer)));

	it("reads the pin out of devDependencies", async () => {
		await expect(
			of({"/repo/package.json": '{"devDependencies":{"@kampus/fabrika-cli":"workspace:*"}}'}),
		).resolves.toBe("workspace:*");
	});

	it("reads the pin out of dependencies", async () => {
		await expect(
			of({"/repo/package.json": '{"dependencies":{"@kampus/fabrika-cli":"^0.2.0"}}'}),
		).resolves.toBe("^0.2.0");
	});

	it("answers undefined when the repo pins nothing — the warning says so instead", async () => {
		await expect(of({"/repo/package.json": '{"name":"repo"}'})).resolves.toBeUndefined();
	});
});

describe("takeSkipInfer — the recursion guard, read before any filesystem work", () => {
	it("consumes the flag so no verb ever sees it", () => {
		const argv = ["node", "bin.ts", SKIP_INFER_FLAG, "adr", "next"];
		expect(takeSkipInfer(argv, {})).toBe(true);
		expect(argv).toEqual(["node", "bin.ts", "adr", "next"]);
	});

	it("also honours the env var, for a caller that cannot alter argv", () => {
		expect(takeSkipInfer(["node", "bin.ts"], {[SKIP_INFER_ENV]: "1"})).toBe(true);
	});

	it("is false for an ordinary invocation, which is what makes delegation happen at all", () => {
		expect(takeSkipInfer(["node", "bin.ts", "adr", "next"], {})).toBe(false);
	});
});
