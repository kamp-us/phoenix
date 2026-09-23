/**
 * Prove an outside author can build and test a program against the packed SDK (#9654). It packs
 * `@kampus/tuval-sdk`, copies `example/` to a temporary directory outside the checkout, installs the
 * tarball there with npm, type-checks the example and runs its test, then fails if either phase
 * resolved a file inside the checkout. The judging lives in `outside.ts`.
 *
 * The test phase's hook sees what Node itself loads, which is every installed package. The
 * example's own files, and anything they import by path, are transformed by vitest instead of
 * loaded by Node, so the typecheck phase is what covers them: tsc follows those same imports.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect, Schema, Stream} from "effect";
import {ChildProcess} from "effect/unstable/process";
import {effectPin, judge, listedFiles, placement, render, resolvedFiles} from "./outside.ts";

const PROOF_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(PROOF_DIR, "..");
const CHECKOUT = realpathSync(resolve(PACKAGE_ROOT, "../.."));

class ProofFailed extends Schema.TaggedError<ProofFailed>()("tuval-sdk/ProofFailed", {
	message: Schema.String,
}) {}

/**
 * What the example's tools run under: enough for npm to find its cache and the tools on `PATH`, and
 * nothing a `pnpm run` in the checkout sets, so no `npm_config_*` value reaches npm from the workspace.
 */
const outsideEnv = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => {
	const env: Record<string, string> = {...extra};
	for (const key of ["PATH", "HOME", "TMPDIR", "CI"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
};

interface Run {
	readonly file: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	/** Absent: inherit the checkout's environment. Present: exactly this environment. */
	readonly env?: Record<string, string>;
	/** Capture stdout for the caller instead of streaming it to the log. */
	readonly capture?: boolean;
}

const run = (step: string, r: Run) =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* Effect.logInfo(`outside proof: ${step}`);
			const handle = yield* ChildProcess.make(r.file, [...r.args], {
				cwd: r.cwd,
				...(r.env === undefined ? {} : {env: r.env, extendEnv: false}),
				detached: false,
				stdin: "ignore",
				stdout: r.capture === true ? "pipe" : "inherit",
				stderr: "inherit",
			});
			const stdout =
				r.capture === true ? yield* Stream.mkString(Stream.decodeText(handle.stdout)) : "";
			const code = yield* handle.exitCode;
			if (code !== 0) {
				if (stdout !== "") process.stderr.write(stdout);
				return yield* new ProofFailed({message: `${step} exited ${code}`});
			}
			return stdout;
		}),
	).pipe(
		Effect.catchTag("PlatformError", (error) =>
			Effect.fail(new ProofFailed({message: `${step} could not run: ${error.message}`})),
		),
	);

const canonical = (path: string): string => (existsSync(path) ? realpathSync(path) : path);

const proof = Effect.gen(function* () {
	const work = realpathSync(mkdtempSync(join(tmpdir(), "tuval-sdk-outside-")));
	const where = placement(CHECKOUT, work);
	if (where._tag === "Inside") {
		return yield* new ProofFailed({
			message: `the temporary directory ${where.path} lies inside the checkout`,
		});
	}

	const packDir = join(work, "pack");
	mkdirSync(packDir);
	const tarball = (yield* run("pnpm pack", {
		file: "pnpm",
		args: ["pack", "--pack-destination", packDir],
		cwd: PACKAGE_ROOT,
		capture: true,
	}))
		.trim()
		.split("\n")
		.at(-1)
		?.trim();
	if (tarball === undefined || tarball === "") {
		return yield* new ProofFailed({message: "pnpm pack named no tarball"});
	}
	const manifest = yield* run("read the packed manifest", {
		file: "tar",
		args: ["-xzOf", tarball, "package/package.json"],
		cwd: work,
		capture: true,
	});
	const effect = yield* Effect.try({
		try: () => effectPin(manifest),
		catch: (error) => new ProofFailed({message: String(error)}),
	});

	const example = join(work, "example");
	cpSync(join(PACKAGE_ROOT, "example"), example, {
		recursive: true,
		filter: (source) => !source.split("/").includes("node_modules"),
	});
	yield* run("npm install", {
		file: "npm",
		args: ["install", "--no-audit", "--no-fund", "--save-exact", tarball, `effect@${effect}`],
		cwd: example,
		env: outsideEnv(),
	});

	const listed = yield* run("tsc --noEmit", {
		file: join(example, "node_modules", ".bin", "tsc"),
		args: ["--noEmit", "--listFiles", "-p", "."],
		cwd: example,
		env: outsideEnv(),
		capture: true,
	});

	const hook = join(work, "resolve-log.mjs");
	const log = join(work, "resolved.log");
	cpSync(join(PROOF_DIR, "resolve-log.mjs"), hook);
	writeFileSync(log, "");
	yield* run("vitest run", {
		file: join(example, "node_modules", ".bin", "vitest"),
		args: ["run"],
		cwd: example,
		env: outsideEnv({
			NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
			TUVAL_RESOLVE_LOG: log,
		}),
	});

	const verdict = judge(CHECKOUT, {
		typecheck: listedFiles(listed).map(canonical),
		test: resolvedFiles(readFileSync(log, "utf8")).map(canonical),
	});
	if (verdict._tag !== "Clean")
		return yield* new ProofFailed({message: `${render(verdict)}\nkept ${work}`});
	yield* Effect.logInfo(render(verdict));
	rmSync(work, {recursive: true, force: true});
});

proof.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
