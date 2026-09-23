/**
 * The published surface of `@kampus/tuval-sdk`, read off a real `pnpm pack` rather than off the
 * workspace manifest. The workspace `exports` map points at `src/*.ts` for the desk's type-stripping
 * run; what npm serves is `publishConfig.exports`, which pnpm swaps in at pack time, so only the
 * packed `package.json` says what an outside author can import.
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
 * The doors npm serves. `./kernel/*` is public so the desk can use the SDK the way an outside
 * project does, and the README marks it unstable. Adding or removing a door is a change to what
 * this package owes its authors, so it lands here on purpose or not at all.
 */
const DOORS = ["./authoring", "./window", "./ai-agent/ports", "./kernel/*", "./package.json"];

type ExportTarget = string | {readonly [condition: string]: ExportTarget};

interface PackedManifest {
	readonly name: string;
	readonly private?: boolean;
	readonly exports: Readonly<Record<string, ExportTarget>>;
	readonly dependencies?: Readonly<Record<string, string>>;
}

const targetsOf = (target: ExportTarget): ReadonlyArray<string> =>
	typeof target === "string" ? [target] : Object.values(target).flatMap(targetsOf);

let entries: ReadonlyArray<string> = [];
let unpacked = "";
let manifest: PackedManifest;

describe("the packed @kampus/tuval-sdk", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	beforeAll(() => {
		const tmp = mkdtempSync(join(tmpdir(), "tuval-sdk-pack-"));
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
		expect(manifest.name).toBe("@kampus/tuval-sdk");
		expect(manifest.private).toBeUndefined();
	});

	it("opens exactly the declared doors", () => {
		expect(Object.keys(manifest.exports)).toEqual(DOORS);
	});

	it("names no TypeScript source in its exports map", () => {
		const targets = Object.values(manifest.exports).flatMap(targetsOf);
		expect(targets).not.toEqual([]);
		expect(targets.filter((t) => t.endsWith(".ts") && !t.endsWith(".d.ts"))).toEqual([]);
	});

	it("carries a file behind every door", () => {
		for (const [door, target] of Object.entries(manifest.exports)) {
			for (const file of targetsOf(target)) {
				// A pattern door is checked through one module it must serve.
				const path = door.endsWith("/*") ? file.replace("*", "process/Processes") : file;
				expect(existsSync(join(unpacked, path)), `${door} -> ${path}`).toBe(true);
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
				(entry.endsWith(".ts") && !entry.endsWith(".d.ts")) || /\.test\.(js|d\.ts)$/.test(entry),
		);
		expect(offenders).toEqual([]);
	});

	it("pins every dependency to a published version", () => {
		const ranges = Object.values(manifest.dependencies ?? {});
		expect(ranges).not.toEqual([]);
		expect(ranges.filter((range) => /^(catalog|workspace):/.test(range))).toEqual([]);
	});
});
