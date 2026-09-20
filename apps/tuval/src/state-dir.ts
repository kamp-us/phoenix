/**
 * Where Tuval's saved state lives: under the home dir, one directory per project keyed by that
 * checkout's absolute path (ADR 0402). Nothing in this module joins a state path onto a project,
 * and no other module may: the manifest, the process checkpoints and the Pi session files all hang
 * off `homeStateDir`, so a project Tuval opens needs zero files and gets none written into it.
 *
 * `<project>/.tuval/` survives as a config directory alone — `boot`'s `projectConfig` reads
 * `tuval.config.ts` out of it, and `adoptInProjectState` below lifts everything else out of it once
 * and leaves that module behind.
 *
 * The home dir is a parameter everywhere for the same reason it is one on `defaultGlobalConfig`: a
 * test must be able to point it at a temp dir rather than write into the operator's own.
 */

import {createHash} from "node:crypto";
import {homedir} from "node:os";
import {join, sep} from "node:path";
import {Context, Effect, FileSystem, Layer, type PlatformError, Schema} from "effect";

/** The home dir's `.tuval`: the global config module's home, and the root of every project's state. */
export const homeTuvalDir = (home: string = homedir()): string => join(home, ".tuval");

/**
 * The most bytes a key may spend on one directory name. `NAME_MAX` is 255 on every filesystem this
 * app runs on; the margin leaves room for a name Tuval never writes but an operator might.
 */
const KEY_MAX_BYTES = 200;

/** How many hex characters of the path's digest an elided key carries. */
const DIGEST_CHARS = 32;

/** The longest prefix of `text` that fits in `bytes`, never splitting a code point. */
const clip = (text: string, bytes: number): string => {
	let out = "";
	let used = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char);
		if (used + size > bytes) break;
		out += char;
		used += size;
	}
	return out;
};

/**
 * A project checkout's absolute path as one directory name.
 *
 * The shape is Claude Code's — the path is the key and the key is a folder name — with the one
 * thing its plain substitution does not give: two distinct paths are two distinct names. A
 * separator becomes `-` and a literal `-` in the path becomes `--`, so `/a-b/c` and `/a/b/c` encode
 * apart rather than colliding on `-a-b-c`. The escape is injective, which is the rule ADR 0402's
 * rule 4 states; decoding is never needed, because `project.json` inside the directory records the
 * path the key came from.
 *
 * A path too long to spend on one filename is elided to a fitting head plus a digest of the whole
 * path, which keeps distinct paths distinct for the reason a content address does.
 */
export const projectKey = (project: string): string => {
	const escaped = project.replaceAll("-", "--").split(sep).join("-");
	if (Buffer.byteLength(escaped) <= KEY_MAX_BYTES) return escaped;
	const digest = createHash("sha256").update(project).digest("hex").slice(0, DIGEST_CHARS);
	return `${clip(escaped, KEY_MAX_BYTES - DIGEST_CHARS - 1)}-${digest}`;
};

/**
 * This project's state directory under the home dir. Two worktrees of one repository are two paths,
 * so they are two directories and share nothing (ADR 0402 rule 5); a moved checkout is a new key
 * and an empty desk (rule 6).
 */
export const homeStateDir = (project: string, home: string = homedir()): string =>
	join(homeTuvalDir(home), "projects", projectKey(project));

/**
 * The desk's Pi session store, under its state dir. A session's `cwd` says where the agent works
 * and never selects this directory, so a session opened against a foreign repo writes nothing into
 * it (ADR 0402 rule 3).
 */
export const piSessionStore = (stateDir: string): string => join(stateDir, "pi-sessions");

/**
 * The file a state directory records its own key's source path in. Home-dir state is per machine
 * and never in a diff, so a desk that misbehaves is debugged from a directory nobody else can see —
 * this is what lets an operator read a key back to the checkout it was derived from.
 */
export const PROJECT_MARKER = "project.json";

const ProjectMarker = Schema.Struct({path: Schema.String});

/** Bytes at the marker path that are not JSON at all. Never surfaced: `recordedPath` reads it as an absence. */
class MarkerUnreadable extends Schema.TaggedError<MarkerUnreadable>()(
	"tuval/MarkerUnreadable",
	{},
) {}

/**
 * The path a marker file records, or `null` for bytes that are not a marker. Bytes that do not
 * decode say nothing about which project owns the directory, so they are a rewrite rather than
 * another checkout's claim on it.
 */
const recordedPath = (text: string): Effect.Effect<string | null> =>
	Effect.try({
		try: (): unknown => JSON.parse(text),
		catch: () => new MarkerUnreadable(),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ProjectMarker)),
		Effect.map((marker) => marker.path),
		Effect.orElseSucceed(() => null),
	);

/**
 * Two projects resolved to one state directory. Unreachable through `projectKey`, which is
 * injective — so reaching it means the encoding changed under state already on disk, and a boot
 * that wrote on anyway would hand one desk another's processes.
 */
export class StateKeyCollision extends Schema.TaggedError<StateKeyCollision>()(
	"tuval/StateKeyCollision",
	{stateDir: Schema.String, project: Schema.String, recorded: Schema.String},
) {
	override get message(): string {
		return `state dir ${this.stateDir} was derived from ${this.recorded}, not from ${this.project}`;
	}
}

/**
 * The state directory, made and stamped with the path it was keyed from. Refuses rather than
 * writing when the directory on disk records another project.
 */
export const prepareStateDir = Effect.fn("Tuval.prepareStateDir")(function* (
	project: string,
	stateDir: string,
) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(stateDir, {recursive: true});
	const marker = join(stateDir, PROJECT_MARKER);
	if (yield* fs.exists(marker)) {
		const recorded = yield* recordedPath(yield* fs.readFileString(marker));
		if (recorded !== null && recorded !== project) {
			return yield* new StateKeyCollision({stateDir, project, recorded});
		}
	}
	yield* fs.writeFileString(marker, `${JSON.stringify({path: project}, null, "\t")}\n`);
	return stateDir;
});

/** What one boot's adoption of in-project state moved, and what it found already adopted. */
export interface StateAdoption {
	/** Entries lifted out of `<project>/.tuval` into the home-dir key. */
	readonly moved: ReadonlyArray<string>;
	/** Entries left where they were, because the home-dir key already holds one under that name. */
	readonly kept: ReadonlyArray<string>;
}

/** The one file `<project>/.tuval/` may still hold after adoption: the project's config layer. */
const CONFIG_MODULE = "tuval.config.ts";

/**
 * Move an entry across, falling back to a copy when the two directories are on different volumes —
 * `rename` is `EXDEV` there, and a home dir on another volume than the checkout is ordinary.
 */
const lift = (
	from: string,
	to: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs
			.rename(from, to)
			.pipe(
				Effect.catch(() =>
					fs.copy(from, to).pipe(Effect.andThen(fs.remove(from, {recursive: true}))),
				),
			);
	});

/**
 * ADR 0402 rule 7's one-time move: state already sitting under `<project>/.tuval` is lifted into
 * that project's home-dir key, once, by boot code — never by a hand edit on an operator's machine.
 * The config module stays behind, because that directory goes on being a config directory.
 *
 * An entry the home-dir key already holds is left where it is rather than overwritten: the desk
 * that wrote the home-dir copy is the live one, and destroying either copy is not this move's call.
 * Nothing reads the left-behind entry afterwards — there is no fallback path back into the project
 * (ADR 0402's Banned list), so what stays is inert bytes an operator can delete.
 */
export const adoptInProjectState = Effect.fn("Tuval.adoptInProjectState")(function* (
	projectTuvalDir: string,
	stateDir: string,
) {
	const fs = yield* FileSystem.FileSystem;
	if (!(yield* fs.exists(projectTuvalDir))) return {moved: [], kept: []} satisfies StateAdoption;
	const entries = yield* fs.readDirectory(projectTuvalDir);
	const moved: Array<string> = [];
	const kept: Array<string> = [];
	for (const entry of entries) {
		if (entry === CONFIG_MODULE) continue;
		const target = join(stateDir, entry);
		if (yield* fs.exists(target)) {
			kept.push(entry);
			continue;
		}
		yield* lift(join(projectTuvalDir, entry), target);
		moved.push(entry);
	}
	return {moved, kept} satisfies StateAdoption;
});

/**
 * The state directory this desk was booted on, as a kernel service.
 *
 * A program row's layer declares it as a leftover requirement and is handed it at spawn — the seam
 * `Features` and `SpellBridge` already arrive through — because a config module is evaluated before
 * `boot` has resolved anything, so a row's layer is a closure that cannot read one. The Pi row is
 * what needs it: its session store is the desk's, and deriving one from a session's `cwd` is the
 * write into a foreign repo ADR 0402 bans.
 */
export class StateDir extends Context.Service<StateDir, {readonly path: string}>()(
	"tuval/StateDir",
) {
	static readonly layer = (path: string): Layer.Layer<StateDir> => Layer.succeed(StateDir, {path});
}
