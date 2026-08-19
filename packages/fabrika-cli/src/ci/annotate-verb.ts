/**
 * `ci annotate` — a pass-through filter that re-emits each tsc diagnostic as a GitHub `::error`
 * workflow command, so a failing CI typecheck lands inline on the PR diff (#3873).
 *
 *   pnpm typecheck | node packages/fabrika-cli/src/bin.ts ci annotate
 *
 * **The one verb in this package that writes streams itself instead of returning a `VerbOutcome`.**
 * The outcome shape buffers stdout to the end, and the whole point here is that the CI log stays
 * live while the typecheck runs — withholding it until EOF would make a long typecheck look hung.
 *
 * Two contracts it must never break:
 *
 *   - **It always exits 0.** It is a reporter, not a gate. The typecheck's redness rides on the
 *     producer's own exit code through `set -o pipefail`; exiting non-zero here would only mask
 *     which side failed, and doing so on its own parse trouble would turn a green typecheck red.
 *   - **It never swallows a line.** Whatever came in goes back out, unmodified, first.
 */

import {Effect, type FileSystem, type Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {annotationsEnabled} from "../guard/annotate.ts";
import {scanWorkspaceMembers} from "../guard/members.ts";
import {annotationsFor, type WorkspaceMember} from "./tsc-annotate.ts";

const VERB = "ci annotate";

export interface AnnotateOptions {
	/** Emit annotations outside GitHub Actions too — local verification. */
	readonly force: boolean;
	/** An explicit repo root the annotated paths are relative to, or `null` to walk up from `cwd`. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Stream fd 0 to stdout as it arrives, resolving to everything that was read. */
	readonly passThrough: Effect.Effect<string>;
	readonly write: (line: string) => void;
	readonly warn: (line: string) => void;
}

/**
 * Stream stdin through to stdout as it arrives while accumulating it for the annotation pass.
 *
 * Deliberately not `io/stdin.ts`'s reader: that one buffers to EOF before returning, which would
 * withhold the whole CI log until the typecheck ends. A mid-read failure resolves to what was read
 * rather than to an error — the reporter must not fail the step it reports on.
 */
export const passThroughStdin: Effect.Effect<string> = Effect.callback<string>((resume) => {
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
		.on("error", finish);
});

/** The scanned members that declare a package name — turbo's line prefix is that name. */
const namedMembers = (
	root: string,
): Effect.Effect<ReadonlyArray<WorkspaceMember>, never, FileSystem.FileSystem | Path.Path> =>
	scanWorkspaceMembers(root).pipe(
		Effect.map((scan) =>
			scan.members.flatMap((member) =>
				member.name === null ? [] : [{name: member.name, dir: member.dir}],
			),
		),
		Effect.catch(() => Effect.succeed([])),
	);

export const runAnnotate = (
	options: AnnotateOptions,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		// Pass-through FIRST and unconditionally: the log must be intact even if nothing below runs.
		const output = yield* options.passThrough;
		if (!options.force && !annotationsEnabled(options.env)) return;

		// Every read below falls back rather than failing: an unreadable workspace costs annotations,
		// and a reporter that failed the step it reports on would cost the diagnostics themselves.
		const root =
			options.root ??
			(yield* discoverRepoRoot(options.cwd).pipe(
				Effect.map((found) => found ?? options.cwd),
				Effect.catch(() => Effect.succeed(options.cwd)),
			));
		const members = yield* namedMembers(root);
		if (members.length === 0) {
			// Loud, but NOT fatal: with no member map a turbo-prefixed path cannot be re-rooted, and a
			// reporter that fails the build it reports on is worse than one that reports less.
			options.warn(
				`${VERB}: found no named workspace members under ${root} — diagnostics from turbo-prefixed lines cannot be re-rooted and will not be annotated.`,
			);
		}
		for (const annotation of annotationsFor(output, {members, root})) options.write(annotation);
	});
