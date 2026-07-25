/**
 * The `tsc-annotate` tool — `pipeline-cli tsc-annotate map [--force] [--root <d>]`.
 *
 *   pnpm typecheck | node packages/pipeline-cli/src/bin.ts tsc-annotate map
 *
 * A pass-through filter for the CI typecheck step (#3873): it echoes stdin to stdout
 * byte-for-byte (so the raw log stays exactly as readable as before) and then re-emits
 * each tsc diagnostic as a GitHub `::error file=…,line=…,col=…::` workflow command, which
 * GitHub renders as an inline annotation on the PR diff. tsc has no native annotations
 * reporter; its diagnostic format maps onto the workflow command mechanically.
 *
 * Two contracts this tool must never break:
 *
 *   - **It always exits 0.** It is a reporter, not a gate. The redness of the typecheck is
 *     carried by the producer's exit code through `set -o pipefail` in the CI step — this
 *     process exiting non-zero would only ever mask which side actually failed, and
 *     exiting non-zero on its OWN parse trouble would turn a green typecheck red.
 *   - **It never swallows a line.** Whatever came in goes back out, unmodified, first.
 *
 * Annotating is CI-only (`GITHUB_ACTIONS` set), so a local `pnpm typecheck | …` sees the
 * plain tsc output; `--force` opts in for local verification.
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {parse as parseYaml} from "yaml";
import {findRootDir} from "../../find-root-dir.ts";
import {annotationsFor, type WorkspaceMember} from "./tsc-annotate.ts";

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

const defaultRoot = (from: string = process.cwd()): string => {
	const start = resolve(from);
	return (
		findRootDir(start, (dir) => ROOT_MARKERS.some((m) => existsSync(join(dir, m))), dirname) ??
		start
	);
};

/**
 * The `packages:` globs from `pnpm-workspace.yaml` reduced to their parent dirs. Only the
 * `<dir>/*` shape the repo actually uses is understood; anything else is skipped rather
 * than half-resolved (a missed dir costs one un-annotated package, never a wrong path).
 */
const workspaceGlobDirs = (root: string): ReadonlyArray<string> => {
	const file = join(root, "pnpm-workspace.yaml");
	if (!existsSync(file)) return [];
	const globs: unknown = (parseYaml(readFileSync(file, "utf8")) as {packages?: unknown})?.packages;
	if (!Array.isArray(globs)) return [];
	return globs
		.filter((g): g is string => typeof g === "string" && g.endsWith("/*"))
		.map((g) => g.slice(0, -2));
};

/** Every workspace member as `{name, dir}` with `dir` repo-relative — turbo's line prefix is the name. */
const readMembers = (root: string): ReadonlyArray<WorkspaceMember> => {
	const members: Array<WorkspaceMember> = [];
	for (const parent of workspaceGlobDirs(root)) {
		const abs = join(root, parent);
		if (!existsSync(abs)) continue;
		for (const child of readdirSync(abs, {withFileTypes: true})) {
			if (!child.isDirectory()) continue;
			const manifest = join(abs, child.name, "package.json");
			if (!existsSync(manifest)) continue;
			const name: unknown = JSON.parse(readFileSync(manifest, "utf8")).name;
			if (typeof name === "string") members.push({name, dir: `${parent}/${child.name}`});
		}
	}
	return members;
};

/**
 * Stream stdin through to stdout as it arrives (the CI log stays live, not withheld until
 * the typecheck ends) while accumulating it for the annotation pass.
 *
 * Deliberately NOT `readFileSync(0)`: on a non-blocking pipe that throws EAGAIN, and this
 * filter sits on the whole typecheck log — a swallowed EAGAIN silently deletes every line
 * of it. Observed live while rehearsing this step, not theorised.
 */
const passThroughStdin = Effect.callback<string>((resume) => {
	const chunks: Array<Buffer> = [];
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		resume(Effect.succeed(Buffer.concat(chunks).toString("utf8")));
	};
	process.stdin
		.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			process.stdout.write(chunk);
		})
		.on("end", finish)
		// A mid-read stdin failure resolves to what was read, never to an error channel: the
		// reporter must not fail the step it reports on.
		.on("error", finish);
});

const forceFlag = Flag.boolean("force").pipe(
	Flag.withDescription("emit annotations even outside GitHub Actions (local verification)"),
);

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("the repo root the annotated paths are relative to (default: walk up)"),
);

const map = Command.make(
	"map",
	{force: forceFlag, root: rootFlag},
	Effect.fn(function* ({force, root}) {
		// Pass-through FIRST and unconditionally: the log must be intact even if nothing below runs.
		const output = yield* passThroughStdin;
		if (!force && process.env.GITHUB_ACTIONS === undefined) return;

		const repoRoot = Option.getOrElse(root, () => defaultRoot());
		const members = readMembers(repoRoot);
		if (members.length === 0) {
			// Loud, but NOT fatal: with no member map a turbo-prefixed path can't be re-rooted, and a
			// reporter that fails the build it reports on is worse than one that reports less.
			process.stderr.write(
				`tsc-annotate: found no workspace members under ${repoRoot} — diagnostics from turbo-prefixed lines cannot be re-rooted and will not be annotated.\n`,
			);
		}
		const annotations = annotationsFor(output, {members, root: repoRoot});
		yield* Effect.sync(() => {
			for (const annotation of annotations) process.stdout.write(`${annotation}\n`);
		});
	}),
).pipe(
	Command.withDescription(
		"Echo tsc output through, re-emitting each diagnostic as a ::error workflow command (CI-only unless --force)",
	),
);

export const tscAnnotateCommand = Command.make("tsc-annotate").pipe(
	Command.withSubcommands([map]),
	Command.withDescription(
		"Map tsc/tsgo diagnostics to GitHub ::error annotations so a failed typecheck lands on the PR diff (#3873)",
	),
);
