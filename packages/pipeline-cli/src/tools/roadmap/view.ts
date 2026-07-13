/**
 * The `roadmap view` IO seam — wiring the pure `roadmap.ts` core to the two facts it renders:
 * `ROADMAP.md`'s text (read from disk) and the live GitHub projection (read over `gh api` via the
 * `Github` service). Split from `command.ts` so the wiring is crossable in tests, and kept thin:
 * it reads ROADMAP.md, parses the arc/campaign tables, gathers the projection, builds + renders the
 * tree, and prints it to stdout. Read-only — no verdict, no `CheckFailed`; the only failure is a
 * genuine IO/`gh` crash (also non-zero, per the bin's contract). This is a render, not a guard.
 */
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
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

const readRoadmap = (root: string): Effect.Effect<string, IoError> =>
	Effect.try({
		try: () => {
			const path = join(root, ROADMAP_FILE);
			if (!existsSync(path)) {
				throw new Error(`${ROADMAP_FILE} not found at repo root`);
			}
			return readFileSync(path, "utf8");
		},
		catch: (cause) => new IoError({path: join(root, ROADMAP_FILE), cause}),
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
	Github
> =>
	Effect.gen(function* () {
		const md = yield* readRoadmap(root);
		const {arcs, campaigns} = parseRoadmap(md);
		const facts = yield* (yield* Github).gather();
		yield* Console.log(renderView(buildView(arcs, campaigns, facts)));
	});
