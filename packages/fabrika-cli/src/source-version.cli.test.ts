/**
 * `fabrika --version` run for real from this source checkout: the commit it names is this
 * checkout's even when the cwd is another repository, and a missing git still exits 0 with the
 * plain version.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";
import {VERSION} from "./version.ts";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();

/** `FABRIKA_SKIP_INFER` pins the run to this copy rather than whatever the cwd's repo pins. */
const version = (cwd: string, env: NodeJS.ProcessEnv = {}): string =>
	execFileSync(process.execPath, [BIN, "--version"], {
		cwd,
		encoding: "utf8",
		env: {...process.env, FABRIKA_SKIP_INFER: "1", ...env},
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

describe("fabrika --version from source", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("names this checkout's commit when the cwd is another repository", () => {
		const foreign = mkdtempSync(join(tmpdir(), "fabrika-version-"));
		git(foreign, "init", "--quiet");
		git(
			foreign,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@example.invalid",
			"commit",
			"--quiet",
			"--allow-empty",
			"-m",
			"foreign",
		);
		const own = git(PACKAGE_DIR, "rev-parse", "--short", "HEAD");
		const theirs = git(foreign, "rev-parse", "--short", "HEAD");

		const printed = version(foreign);
		rmSync(foreign, {recursive: true, force: true});

		expect(printed).toMatch(new RegExp(`^fabrika v${VERSION}\\+${own}(-dirty)? \\(source\\)$`));
		expect(printed).not.toContain(theirs);
	});

	it("prints the plain version and exits 0 when git cannot be found", () => {
		expect(version(tmpdir(), {PATH: ""})).toBe(`fabrika v${VERSION}`);
	});
});
