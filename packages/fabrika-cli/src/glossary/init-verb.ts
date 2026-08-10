/**
 * `glossary init` — create a register file that does not exist, so a fresh repo is not a dead end.
 *
 * Without it `bootstrap` is a state the skill can reach and never leave: `add` matches `--section`
 * against live headings, and a file that is not there has none (#4776).
 *
 * The refusal on an existing register is `adr new`'s idiom reseated on this group's `12` — a register
 * is the one artefact whose accidental overwrite destroys the most work.
 */
import {Effect, Path, Result} from "effect";
import {exists, readFile, writeFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, READBACK_MISMATCH, TERM_COLLISION, WRITE_UNKNOWN} from "./codes.ts";
import {type GlossaryEffect, registerFilesIn, resolveDir, selectRegisters} from "./guards.ts";
import {registerTemplate} from "./template.ts";

const VERB = "glossary init";

export interface InitOptions {
	readonly register: string;
	readonly dir: string;
	readonly json: boolean;
	readonly cwd: string;
}

export const runInit = (options: InitOptions): GlossaryEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const selected = selectRegisters(VERB, options.register, {
			allowed: false,
			refusal: `${VERB}: --register both is not creatable — create each register explicitly.`,
		});
		if (selected._tag === "Refused") return selected.outcome;
		const register = selected.value[0] as "terms" | "language";

		const dir = yield* resolveDir(VERB, options.cwd, options.dir);
		if (dir._tag === "Refused") return dir.outcome;
		const pathService = yield* Path.Path;
		const file = registerFilesIn(dir.value, [register], pathService)[0] as {
			readonly display: string;
			readonly path: string;
		};

		const present = yield* Effect.result(exists(file.path));
		// A probe that could not be performed is UNKNOWN, never "absent" — answering absent here would
		// license a write over a register this process never managed to look at.
		if (Result.isFailure(present)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${file.display}: ${present.failure.reason} — nothing was written.`,
			);
		}
		if (present.success) {
			return refuse(
				TERM_COLLISION,
				`${VERB}: ${file.display} already exists — refusing to overwrite a register.`,
			);
		}

		const template = registerTemplate(pathService.basename(dir.value.root), register);
		const written = yield* Effect.result(writeFile(file.path, template));
		if (Result.isFailure(written)) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: cannot write ${file.display}: ${written.failure.reason} — the outcome is UNKNOWN.`,
			);
		}

		const readBack = yield* Effect.result(readFile(file.path));
		if (Result.isFailure(readBack) || readBack.success !== template) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${file.display} and the read-back does not match the template.`,
			);
		}

		const scope = [`${VERB}: created ${file.display} for register ${register}.`];
		if (options.json) {
			return answer(JSON.stringify({action: "created", path: file.display, register}), scope);
		}
		return answer(`created\t${file.display}`, scope);
	});
