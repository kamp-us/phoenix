/**
 * The published surface of `@kampus/tuval-agy`, read off a real `pnpm pack` rather than off the
 * workspace manifest. The workspace `exports` map points at `src/*.ts` for the desk's Vite and
 * type-stripping run; what npm serves is `publishConfig.exports`, which pnpm swaps in at pack time,
 * so only the packed `package.json` says what a consumer can import.
 */
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {beforeAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The doors npm serves, the workspace map's own. Adding or removing a door is a change to what this
 * package owes its consumers, so it lands here on purpose or not at all.
 */
const DOORS = [".", "./ai-agent", "./window", "./package.json"];

type ExportTarget = string | {readonly [condition: string]: ExportTarget};

interface PackedManifest {
	readonly name: string;
	readonly private?: boolean;
	readonly exports: Readonly<Record<string, ExportTarget>>;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly peerDependenciesMeta?: Readonly<Record<string, {readonly optional?: boolean}>>;
}

const targetsOf = (target: ExportTarget): ReadonlyArray<string> =>
	typeof target === "string" ? [target] : Object.values(target).flatMap(targetsOf);

let entries: ReadonlyArray<string> = [];
let unpacked = "";
let manifest: PackedManifest;

describe("the packed @kampus/tuval-agy", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	beforeAll(() => {
		const tmp = mkdtempSync(join(tmpdir(), "tuval-agy-pack-"));
		// `prepack` builds `dist` first, so this is the tarball `pnpm publish` would upload.
		const tarball = execFileSync("pnpm", ["pack", "--pack-destination", tmp], {
			cwd: PACKAGE_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
			.trim()
			.split("\n")
			.at(-1)
			?.trim();
		if (tarball === undefined || tarball === "") throw new Error("pnpm pack named no tarball");
		entries = execFileSync("tar", ["-tzf", tarball], {encoding: "utf8"})
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => line.replace(/^package\//, ""));
		execFileSync("tar", ["-xzf", tarball, "-C", tmp]);
		unpacked = join(tmp, "package");
		manifest = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8")) as PackedManifest;
	}, SUBPROCESS_TEST_TIMEOUT_MS);

	it("is public under its published name", () => {
		expect(manifest.name).toBe("@kampus/tuval-agy");
		expect(manifest.private).toBeUndefined();
	});

	it("opens exactly the declared doors", () => {
		expect(Object.keys(manifest.exports)).toEqual(DOORS);
	});

	it("names no TypeScript source in its exports map", () => {
		const targets = Object.values(manifest.exports).flatMap(targetsOf);
		expect(targets).not.toEqual([]);
		expect(targets.filter((t) => /\.tsx?$/.test(t) && !t.endsWith(".d.ts"))).toEqual([]);
	});

	it("carries a file behind every door", () => {
		for (const [door, target] of Object.entries(manifest.exports)) {
			for (const file of targetsOf(target)) {
				expect(existsSync(join(unpacked, file)), `${door} -> ${file}`).toBe(true);
			}
		}
	});

	it("holds only dist, the README, the manifest and the license pnpm adds", () => {
		const outside = entries.filter(
			(entry) =>
				!entry.startsWith("dist/") && !["package.json", "README.md", "LICENSE"].includes(entry),
		);
		expect(outside).toEqual([]);
		expect(entries.filter((entry) => entry.startsWith("dist/"))).not.toEqual([]);
	});

	it("ships no source and no compiled test", () => {
		const offenders = entries.filter(
			(entry) =>
				(/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) || /\.test\.(js|d\.ts)$/.test(entry),
		);
		expect(offenders).toEqual([]);
	});

	it("pins every dependency to a published version and depends on no app", () => {
		const ranges = {...manifest.dependencies, ...manifest.peerDependencies};
		expect(Object.keys(ranges)).not.toEqual([]);
		expect(Object.keys(ranges).filter((name) => name.startsWith("@kampus-apps/"))).toEqual([]);
		expect(Object.values(ranges).filter((range) => /^(catalog|workspace):/.test(range))).toEqual(
			[],
		);
	});

	it("takes the SDK as a required peer, never a copy of its own", () => {
		expect(manifest.peerDependencies?.["@kampus/tuval-sdk"]).toBeDefined();
		expect(manifest.peerDependenciesMeta?.["@kampus/tuval-sdk"]?.optional).not.toBe(true);
		expect(manifest.dependencies?.["@kampus/tuval-sdk"]).toBeUndefined();
	});

	it("accepts a range of SDK versions, not one exact version", () => {
		expect(manifest.peerDependencies?.["@kampus/tuval-sdk"]).toMatch(/^\^/);
	});
});
