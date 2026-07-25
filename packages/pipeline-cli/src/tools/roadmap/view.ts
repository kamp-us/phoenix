/**
 * The `roadmap view` IO seam — wiring the pure `roadmap.ts` core to the two facts it renders:
 * `ROADMAP.md`'s text (read from disk) and the live GitHub projection (read over `gh api` via the
 * `Github` service). Split from `command.ts` so the wiring is crossable in tests, and kept thin:
 * it reads ROADMAP.md, parses the arc/campaign tables, gathers the projection, builds + renders the
 * tree, and prints it to stdout. Read-only — no verdict, no `CheckFailed`; the only failure is a
 * genuine IO/`gh` crash (also non-zero, per the bin's contract). This is a render, not a guard.
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import type {GhCommandError, GhParseError, RepoResolutionError} from "./github.ts";
import {Github} from "./github.ts";
import {buildView, parseRoadmap, renderView} from "./roadmap.ts";

/** Couldn't read `ROADMAP.md` (absent or unreadable). */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

const ROADMAP_FILE = "ROADMAP.md";

// The file read goes through the `FileSystem`/`Path` seam (over the bin's
// `NodeServices.layer`), so the wiring is crossable off real disk in a test — see
// `.patterns/effect-platform-access.md`. A missing ROADMAP.md keeps its specific
// "not found at repo root" diagnostic; a read fault folds `PlatformError` → `IoError`.
const readRoadmap = (
	root: string,
): Effect.Effect<string, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const target = path.join(root, ROADMAP_FILE);
		if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) {
			return yield* Effect.fail(
				new IoError({path: target, cause: new Error(`${ROADMAP_FILE} not found at repo root`)}),
			);
		}
		return yield* fs
			.readFileString(target, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: target, cause})));
	});

/**
 * Render the roadmap tree: parse `ROADMAP.md`'s `## Arcs`/`## Campaigns` tables, gather the live
 * milestone/issue/PR projection, and emit `buildView`'s assembled tree + stale-p1 drift to stdout.
 */
export const renderRoadmap = (
	root: string,
): Effect.Effect<
	void,
	IoError | RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError,
	Github | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const md = yield* readRoadmap(root);
		const {arcs, campaigns} = parseRoadmap(md);
		const facts = yield* (yield* Github).gather();
		yield* Console.log(renderView(buildView(arcs, campaigns, facts)));
	});
