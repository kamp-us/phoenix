/**
 * The reads and enum checks every `glossary` verb runs before it decides anything, factored here so
 * six verbs cannot disagree about what an absent register is, what an unreadable one is, or which
 * values `--register` admits.
 *
 * **Absent and unreadable are separated at every read**, because that split is what the whole group
 * rests on: an absent register is `bootstrap` — a fact about an adopting repo (#4776) — and a
 * register that exists and could not be read is `11`, UNKNOWN, with nothing answered.
 */

import {Effect, type FileSystem, Path, Result} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, readFile} from "../io/fs.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {BAD_SECTIONS, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	BOTH,
	type ParsedRegister,
	parseRegister,
	REGISTER_FILE,
	type RegisterName,
} from "./register.ts";

export type Guarded<A> =
	| {readonly _tag: "Ok"; readonly value: A}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

export const ok = <A>(value: A): Guarded<A> => ({_tag: "Ok", value});
export const refused = (outcome: VerbOutcome): Guarded<never> => ({_tag: "Refused", outcome});

/** Anything in this module: it reads disk, so the two platform seams are its only requirement. */
export type GlossaryEffect<A> = Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>;

/**
 * The registers `--register` selects, or the `10` an off-enum value earns.
 *
 * `both` is admissible only for the reading verbs. A verb that *writes* refuses it, because a term
 * belongs to one register and creating or editing two from one ambiguous call is the defect.
 */
export const selectRegisters = (
	verb: string,
	value: string,
	both: {readonly allowed: boolean; readonly refusal: string},
): Guarded<ReadonlyArray<RegisterName>> => {
	if (value === "terms" || value === "language") return ok([value]);
	if (value === "both") {
		return both.allowed ? ok(BOTH) : refused(refuse(OFF_VOCABULARY, both.refusal));
	}
	const vocabulary = both.allowed ? "terms, language, both" : "terms, language";
	return refused(
		refuse(OFF_VOCABULARY, `${verb}: --register "${value}" is not one of ${vocabulary}.`),
	);
};

/** A register's two paths: the one a caller sees, and the one this process reads. */
export interface RegisterFile {
	readonly name: RegisterName;
	/** `<--dir>/<FILE>` exactly as the caller spelled `--dir` — what every message and answer prints. */
	readonly display: string;
	/** The same file resolved against the target repo's root, which is what actually gets read. */
	readonly path: string;
}

export interface RegisterDir {
	readonly display: string;
	readonly path: string;
	readonly root: string;
}

/**
 * `--dir` resolved against the target repo's root.
 *
 * The register belongs to the *target repo*, so a relative `--dir` is resolved against its root
 * rather than against whatever directory the process was launched from. A root that could not be
 * probed is `11`: an unreadable ancestor answered as "no repo" would silently relocate every read.
 */
export const resolveDir = (
	verb: string,
	cwd: string,
	dir: string,
): GlossaryEffect<Guarded<RegisterDir>> =>
	Effect.gen(function* () {
		const pathService = yield* Path.Path;
		const display = dir.replace(/\/+$/, "");
		const root = yield* Effect.result(discoverRepoRoot(cwd));
		if (Result.isFailure(root)) {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot resolve the repository root from ${cwd}: ${root.failure.reason} — nothing was read.`,
				),
			);
		}
		return ok<RegisterDir>({
			display,
			path: pathService.resolve(root.success ?? cwd, display),
			root: root.success ?? cwd,
		});
	});

export const registerFilesIn = (
	dir: RegisterDir,
	names: ReadonlyArray<RegisterName>,
	pathService: Path.Path,
): ReadonlyArray<RegisterFile> =>
	names.map((name) => ({
		name,
		display: `${dir.display}/${REGISTER_FILE[name]}`,
		path: pathService.join(dir.path, REGISTER_FILE[name]),
	}));

export type RegisterState =
	| {readonly _tag: "Absent"; readonly file: RegisterFile}
	| {
			readonly _tag: "Present";
			readonly file: RegisterFile;
			readonly text: string;
			readonly parsed: ParsedRegister;
	  };

/** How a verb words the two refusals a register read can produce. */
export interface ReadMessages {
	readonly unreadable: (path: string, reason: string) => string;
	readonly malformed: (path: string, reason: string) => string;
}

/**
 * One register as it sits on disk.
 *
 * Absence is an **answer** the caller routes on; only a file that exists and cannot be read, or a
 * table that exists and cannot be resolved, refuses here.
 */
export const readRegister = (
	file: RegisterFile,
	messages: ReadMessages,
): GlossaryEffect<Guarded<RegisterState>> =>
	Effect.gen(function* () {
		const present = yield* Effect.result(exists(file.path));
		if (Result.isFailure(present)) {
			return refused(
				refuse(PRECONDITION_UNKNOWN, messages.unreadable(file.display, present.failure.reason)),
			);
		}
		if (!present.success) return ok<RegisterState>({_tag: "Absent", file});

		const text = yield* Effect.result(readFile(file.path));
		if (Result.isFailure(text)) {
			return refused(
				refuse(PRECONDITION_UNKNOWN, messages.unreadable(file.display, text.failure.reason)),
			);
		}
		const parsed = parseRegister(text.success);
		if (parsed._tag === "Malformed") {
			return refused(refuse(BAD_SECTIONS, messages.malformed(file.display, parsed.reason)));
		}
		return ok<RegisterState>({_tag: "Present", file, text: text.success, parsed: parsed.value});
	});
