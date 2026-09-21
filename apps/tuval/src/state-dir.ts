/**
 * Where Tuval's saved state lives: under the home dir, one directory per project keyed by that
 * checkout's absolute path (ADR 0402). Nothing in this module joins a state path onto a project,
 * and no other module may: the manifest, the process checkpoints and the Pi session files all hang
 * off `homeStateDir`, so a project Tuval opens needs zero files and gets none written into it.
 *
 * `<project>/.tuval/` survives as a config directory an operator also keeps their own files in —
 * `boot`'s `projectConfig` reads `tuval.config.ts` out of it, and `adoptInProjectState` below lifts
 * the closed set of names Tuval itself writes out of it once, leaving every other name where it is
 * (ADR 0402 rule 7, as amended).
 *
 * The home dir is a required parameter everywhere here, never defaulted: a caller that named none
 * would resolve the operator's own home, and a test or proof that did so would write a desk's
 * manifest, checkpoints and session files into it. The two callers that mean the real home dir say
 * so — `src/bin.ts` and `PiAiAgent`'s store fallback.
 */

import {createHash} from "node:crypto";
import {join, sep} from "node:path";
import {Context, Effect, FileSystem, Layer, type PlatformError, Schema} from "effect";

/** The home dir's `.tuval`: the global config module's home, and the root of every project's state. */
export const homeTuvalDir = (home: string): string => join(home, ".tuval");

/**
 * The most bytes a key may spend on one directory name. `NAME_MAX` is 255 on every filesystem this
 * app runs on; the margin leaves room for a name Tuval never writes but an operator might.
 */
const KEY_MAX_BYTES = 200;

/** How many hex characters of the path's digest an elided key carries. */
const DIGEST_CHARS = 32;

/** The character that leads an escape pair, and is therefore never itself a plain character. */
const ESCAPE = "_";

/**
 * One path character as its production: a literal `-` and a literal `_` each become `_` plus a
 * marker, and everything else stands for itself. A separator is not a character here — `projectKey`
 * emits `-` for one — so the only thing that can produce a `-` is a separator, which is what makes
 * the code prefix-free.
 */
const escapeChar = (char: string): string =>
	char === "-" || char === ESCAPE ? `${ESCAPE}${char}` : char;

/**
 * The longest prefix of an escaped key that fits in `bytes`, never splitting a code point and never
 * splitting an escape pair. A head cut mid-pair would end on a lone `_`, and the digest joined
 * after it would then read as a plain escaped `_` rather than as the elision marker.
 */
const clip = (escaped: string, bytes: number): string => {
	const chars = [...escaped];
	let out = "";
	let used = 0;
	for (let at = 0; at < chars.length; at += 1) {
		const lead = chars[at] ?? "";
		const unit = lead === ESCAPE ? lead + (chars[at + 1] ?? "") : lead;
		const size = Buffer.byteLength(unit);
		if (used + size > bytes) break;
		out += unit;
		used += size;
		if (unit.length > lead.length) at += 1;
	}
	return out;
};

/**
 * A project checkout's absolute path as one directory name.
 *
 * The shape is Claude Code's — the path is the key and the key is a folder name — with the one
 * thing its plain substitution does not give: two distinct paths are two distinct names, which is
 * ADR 0402's rule 4. A separator becomes `-`, a literal `-` becomes `_-` and a literal `_` becomes
 * `__`, so `/a-b/c` and `/a/b/c` encode apart rather than colliding on `-a-b-c`.
 *
 * The escape is injective because the code is prefix-free, read left to right: a `-` can only have
 * come from a separator, since no production puts one anywhere but first; a `_` always opens a pair
 * and its second character says which literal it was. Escaping a run of dashes to a longer run of
 * dashes is what an earlier encoding did, and that is exactly what is not decidable — `/a-/b` and
 * `/a/-b` both produced `-a---b`. Decoding is never run, because `project.json` inside the
 * directory records the path the key came from; the property is what the encoding owes.
 *
 * A path too long to spend on one filename is elided to a fitting head plus a digest of the whole
 * path, which keeps distinct paths distinct for the reason a content address does. The digest is
 * joined on a single `_` followed by a hex character — a sequence no escape emits, since a `_` in
 * an escaped key is always followed by `-` or `_` — so an elided key can never equal a plain one.
 */
export const projectKey = (project: string): string => {
	const escaped = project
		.split(sep)
		.map((segment) => [...segment].map(escapeChar).join(""))
		.join("-");
	if (Buffer.byteLength(escaped) <= KEY_MAX_BYTES) return escaped;
	const digest = createHash("sha256").update(project).digest("hex").slice(0, DIGEST_CHARS);
	return `${clip(escaped, KEY_MAX_BYTES - DIGEST_CHARS - 1)}${ESCAPE}${digest}`;
};

/**
 * This project's state directory under the home dir. Two worktrees of one repository are two paths,
 * so they are two directories and share nothing (ADR 0402 rule 5); a moved checkout is a new key
 * and an empty desk (rule 6).
 */
export const homeStateDir = (project: string, home: string): string =>
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

/**
 * What one boot's adoption of in-project state moved, and the two distinct reasons it left an entry
 * behind. A collision and a name Tuval does not own are different facts about the project's
 * directory — one asks the operator to reconcile two copies of their desk's state, the other says
 * their own file was never touched — so they never share a field.
 */
export interface StateAdoption {
	/** Entries lifted out of `<project>/.tuval` into the home-dir key. */
	readonly moved: ReadonlyArray<string>;
	/** Entries left where they were, because the home-dir key already holds one under that name. */
	readonly kept: ReadonlyArray<string>;
	/** Entries left where they were, because their name is outside the set Tuval writes. */
	readonly unowned: ReadonlyArray<string>;
}

/**
 * The closed set of names Tuval itself writes into `<project>/.tuval`, and therefore the only names
 * the one-time move takes (ADR 0402 rule 7, as amended by the founder's ruling on #9566). A new kind
 * of Tuval state file moves only once it is added here and in that record; until then a project's
 * copy is left behind, which is the cost the ruling accepts.
 */
const TUVAL_STATE_NAMES: ReadonlySet<string> = new Set([
	"manifest.json",
	"processes",
	"pi-sessions",
]);

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
 * ADR 0402 rule 7's one-time move, as amended: the names in `TUVAL_STATE_NAMES` sitting under
 * `<project>/.tuval` are lifted into that project's home-dir key, once, by boot code — never by a
 * hand edit on an operator's machine. Every other name stays where it is, `tuval.config.ts` among
 * them by that rule and not by a skip of its own: a tool moves only the files it wrote, and
 * relocating an operator's notes or scripts without saying so is the surprise the ruling bans.
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
	if (!(yield* fs.exists(projectTuvalDir)))
		return {moved: [], kept: [], unowned: []} satisfies StateAdoption;
	const entries = yield* fs.readDirectory(projectTuvalDir);
	const moved: Array<string> = [];
	const kept: Array<string> = [];
	const unowned: Array<string> = [];
	for (const entry of entries) {
		if (!TUVAL_STATE_NAMES.has(entry)) {
			unowned.push(entry);
			continue;
		}
		const target = join(stateDir, entry);
		if (yield* fs.exists(target)) {
			kept.push(entry);
			continue;
		}
		yield* lift(join(projectTuvalDir, entry), target);
		moved.push(entry);
	}
	return {moved, kept, unowned} satisfies StateAdoption;
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
