/**
 * The `bin/pipeline-cli` shim single-sources the version (#3653, per #3457).
 *
 * The version used to be copy-pasted across ~13 skill `pnpm dlx @kampus/pipeline-cli@<v>`
 * snippets + the installer pin — "single source" was fiction, and that skew shipped #3451.
 * The shim collapses it: skills invoke `bin/pipeline-cli <tool>` with NO version, and the one
 * pin lives in hooks/pin.sh, which the shim sources for its dlx fallback. These tests drive the
 * REAL shim script (the pin-dispatch.hook.test.ts idiom) and assert the three resolution arms
 * plus the standing invariant that no skill re-introduces a pinned version.
 *
 * Coverage note: the shim + hooks are inside CI's `packages` path filter, so a `bin/**` or
 * `hooks/**` edit runs this suite (ADR 0180 / the #2925 gap), the same as pin-dispatch.
 */
import {execFileSync, spawnSync} from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, assert, describe, it} from "@effect/vitest";

const repoPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

const PLUGIN = "claude-plugins/kampus-pipeline";
const SHIM = repoPath(`${PLUGIN}/bin/pipeline-cli`);
const PIN_SH = repoPath(`${PLUGIN}/hooks/pin.sh`);
const SKILLS_DIR = repoPath(`${PLUGIN}/skills`);

/** The pin as the shim itself reads it — sourced, never regex-scraped out of the file. */
const hookPin = (): string =>
	execFileSync("bash", ["-c", `. "${PIN_SH}"; printf '%s' "$KAMPUS_PIPELINE_CLI_PIN"`], {
		encoding: "utf8",
	});

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const runShim = (shim: string, env: NodeJS.ProcessEnv, ...argv: string[]): RunResult => {
	const r = spawnSync("bash", [shim, ...argv], {encoding: "utf8", input: "", env});
	return {code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? ""};
};

/**
 * A throwaway plugin tree holding a COPY of the shim + the hooks it sources, positioned so the
 * shim's in-repo lookup (`$SHIM_DIR/../../../packages/pipeline-cli/src/bin.ts`) resolves to a path
 * that does NOT exist — forcing resolution arm 2 (installed bin) or arm 3 (dlx). Returns the path
 * to the copied shim.
 */
const foreignShim = (): {readonly shim: string; readonly root: string} => {
	const root = mkdtempSync(join(tmpdir(), "pipeline-shim-"));
	const bin = join(root, PLUGIN, "bin");
	const hooks = join(root, PLUGIN, "hooks");
	mkdirSync(bin, {recursive: true});
	mkdirSync(hooks, {recursive: true});
	const shim = join(bin, "pipeline-cli");
	copyFileSync(SHIM, shim);
	chmodSync(shim, 0o755);
	copyFileSync(PIN_SH, join(hooks, "pin.sh"));
	copyFileSync(repoPath(`${PLUGIN}/hooks/resolve-data-dir.sh`), join(hooks, "resolve-data-dir.sh"));
	return {shim, root};
};

/** A data dir with a stub `pipeline-cli` that echoes its argv, plus the attested version marker. */
const dataDirWith = (marker: string | null): string => {
	const data = mkdtempSync(join(tmpdir(), "pipeline-data-"));
	const bin = join(data, "node_modules", ".bin", "pipeline-cli");
	mkdirSync(dirname(bin), {recursive: true});
	writeFileSync(bin, '#!/usr/bin/env bash\necho "DISPATCHED $*"\n');
	chmodSync(bin, 0o755);
	if (marker !== null) writeFileSync(join(data, ".pipeline-cli.version"), marker);
	return data;
};

/** A PATH-first stub dir whose `pnpm` echoes its argv, so "did the shim dlx?" reads off stdout. */
const stubPnpmDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-pnpm-"));
	const pnpm = join(dir, "pnpm");
	writeFileSync(pnpm, '#!/usr/bin/env bash\necho "PNPM $*"\n');
	chmodSync(pnpm, 0o755);
	return dir;
};

/** Env with every data-dir signal stripped, so foreign resolution can't accidentally find one. */
const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = {...process.env, ...extra};
	delete env.CLAUDE_PROJECT_DIR;
	delete env.CLAUDE_PLUGIN_DATA;
	if (!("KAMPUS_PIPELINE_DATA" in extra)) delete env.KAMPUS_PIPELINE_DATA;
	return env;
};

describe("bin/pipeline-cli shim resolution (#3653)", () => {
	const dirs: string[] = [];
	const track = <T extends string>(d: T): T => {
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
	});

	it("arm 1 — in the phoenix checkout, runs the in-repo bin and forwards argv", () => {
		const {code, stdout} = runShim(SHIM, process.env, "version");
		assert.strictEqual(code, 0);
		assert.strictEqual(
			stdout.trim(),
			`pipeline-cli ${hookPin()}`,
			"the shim must run the in-repo consolidated bin and pass the subcommand through",
		);
	});

	it("arm 2 — no in-repo bin: dispatches the installed data-dir bin when its marker == pin", () => {
		const {shim, root} = foreignShim();
		track(root);
		const data = track(dataDirWith(hookPin()));
		const {code, stdout} = runShim(shim, cleanEnv({KAMPUS_PIPELINE_DATA: data}), "verdict", "read");
		assert.strictEqual(code, 0);
		assert.strictEqual(
			stdout.trim(),
			"DISPATCHED verdict read",
			"an installed bin at the pinned version must be exec'd, argv forwarded",
		);
	});

	it("arm 2 skipped — a stale installed bin (marker != pin) is NOT dispatched; falls to dlx", () => {
		const {shim, root} = foreignShim();
		track(root);
		const data = track(dataDirWith("0.1.0")); // stale tree left by a failed install
		const stub = track(stubPnpmDir());
		const env = cleanEnv({KAMPUS_PIPELINE_DATA: data, PATH: `${stub}:${process.env.PATH ?? ""}`});
		const {stdout} = runShim(shim, env, "version");
		assert.notInclude(stdout, "DISPATCHED", "a non-pinned installed tree must never be exec'd");
		assert.include(stdout, "PNPM dlx", "resolution must fall through to the dlx fallback");
	});

	it("arm 3 — no in-repo bin, no installed bin: dlx's the exact pinned version from the ONE pin", () => {
		const {shim, root} = foreignShim();
		track(root);
		const stub = track(stubPnpmDir());
		const env = cleanEnv({PATH: `${stub}:${process.env.PATH ?? ""}`});
		const {code, stdout} = runShim(shim, env, "verdict", "read");
		assert.strictEqual(code, 0);
		assert.strictEqual(
			stdout.trim(),
			`PNPM dlx @kampus/pipeline-cli@${hookPin()} verdict read`,
			"the fallback must fetch @<pin> read from hooks/pin.sh (single source) and forward argv",
		);
	});
});

describe("the single source stays single (#3653, the reshaped #3452 guard)", () => {
	// Every skill/hook re-fetch of the version must go through the shim; a hardcoded pinned
	// `@kampus/pipeline-cli@<digits>` anywhere in the plugin tree is the exact duplication #3653
	// deleted. `@latest` (README install docs) and the shim's own `@<v>`/`@<pin>` prose are not
	// pinned versions, so `@` + a digit is the precise, low-false-positive signal.
	const walk = (dir: string): string[] =>
		readdirSync(dir, {recursive: true, withFileTypes: true})
			.filter((e) => e.isFile())
			.map((e) => join(e.parentPath, e.name));

	it("no plugin file hardcodes a pinned @kampus/pipeline-cli@<version>", () => {
		const offenders = walk(repoPath(PLUGIN))
			.filter((f) => /\.(md|sh)$/.test(f) || f.endsWith("/pipeline-cli"))
			.filter((f) => /@kampus\/pipeline-cli@[0-9]/.test(readFileSync(f, "utf8")))
			.map((f) => f.slice(repoPath("").length));
		assert.deepStrictEqual(
			offenders,
			[],
			"these files re-introduced a pinned version — invoke the bin/pipeline-cli shim instead (#3653)",
		);
	});

	it("the skills invoke the shim, not a bare per-skill version", () => {
		// Sanity floor: at least one skill actually routes through the shim, so the guard above is
		// asserting over a real consumer set rather than passing vacuously on an empty tree.
		const usesShim = walk(SKILLS_DIR).some(
			(f) => f.endsWith(".md") && /bin\/pipeline-cli/.test(readFileSync(f, "utf8")),
		);
		assert.isTrue(usesShim, "skills must call the bin/pipeline-cli shim");
	});
});
