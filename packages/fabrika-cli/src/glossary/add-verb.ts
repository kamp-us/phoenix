/**
 * `glossary add` — insert or replace one row, alphabetically placed, byte-preserving elsewhere.
 *
 * Three properties carry this verb, and each is a mechanism rather than an intention: the one-row
 * assertion aborts before the write when the composed text differs anywhere but the target splice
 * (`15`), the read-back re-parses the row that landed and refuses when it is not what was composed
 * (`9`, a different fact from a write that failed, `8`), and `--replace` on an absent term refuses
 * (`12`) rather than adding — a caller whose belief about the register is wrong should learn that
 * instead of having it hidden.
 */
import {Effect, Path, Result} from "effect";
import {readFile, writeFile} from "../io/fs.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	EDIT_BEYOND_ROW,
	EMPTY_STDIN,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	ROW_SHAPE_INVALID,
	SECTION_ABSENT,
	TERM_COLLISION,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {appendIndex, linesChangedBeyond, newSectionBlock, placeRow, type Splice} from "./edit.ts";
import {
	type GlossaryEffect,
	type Guarded,
	ok,
	readRegister,
	refused,
	registerFilesIn,
	resolveDir,
	selectRegisters,
} from "./guards.ts";
import {escapeCell, flattenCell, normalizeKey, parseRegister, renderRow} from "./register.ts";

const VERB = "glossary add";

export interface AddOptions {
	readonly term: string;
	readonly register: string;
	readonly section: string;
	readonly definitionFile: string;
	readonly notFile: string | null;
	readonly replace: boolean;
	readonly createSection: boolean;
	readonly dir: string;
	readonly json: boolean;
	readonly cwd: string;
	readonly stdin: Effect.Effect<StdinRead>;
}

const messages = (section: string) => ({
	unreadable: (path: string, reason: string) =>
		`${VERB}: cannot read ${path}: ${reason} — nothing was written.`,
	malformed: (path: string, _reason: string) =>
		`${VERB}: ${path} has no parseable table under "${section}" — the insertion point is UNKNOWN, nothing written.`,
});

/** The definition or `Not` cell's source text: a file, or fd 0 when the source is `-`. */
const readSource = (
	source: string,
	cwd: string,
	stdin: Effect.Effect<StdinRead>,
	flag: string,
): GlossaryEffect<Guarded<string>> =>
	Effect.gen(function* () {
		if (source === "-") {
			const read = yield* stdin;
			if (read._tag === "Failed") {
				return refused(
					refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot read ${flag} -: ${read.reason} — nothing was written.`,
					),
				);
			}
			// A TTY carried nothing to read, which is the same fact as a pipe that arrived empty: the
			// caller asked for a definition on fd 0 and supplied none.
			if (read._tag === "NoStdin")
				return refused(refuse(EMPTY_STDIN, `${VERB}: stdin held nothing.`));
			if (flattenCell(read.text) === "") {
				return refused(refuse(EMPTY_STDIN, `${VERB}: stdin held nothing.`));
			}
			return ok(read.text);
		}
		const pathService = yield* Path.Path;
		const text = yield* Effect.result(readFile(pathService.resolve(cwd, source)));
		return Result.isFailure(text)
			? refused(
					refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot read ${flag} ${source}: ${text.failure.reason} — nothing was written.`,
					),
				)
			: ok(text.success);
	});

export const runAdd = (options: AddOptions): GlossaryEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const selected = selectRegisters(VERB, options.register, {
			allowed: false,
			refusal: `${VERB}: --register both is not writable — a term belongs to one register.`,
		});
		if (selected._tag === "Refused") return selected.outcome;
		const register = selected.value[0] as "terms" | "language";

		const dir = yield* resolveDir(VERB, options.cwd, options.dir);
		if (dir._tag === "Refused") return dir.outcome;
		const pathService = yield* Path.Path;
		const file = registerFilesIn(dir.value, [register], pathService)[0];
		if (file === undefined) return refuse(PRECONDITION_UNKNOWN, `${VERB}: no register resolved.`);

		const state = yield* readRegister(file, messages(options.section));
		if (state._tag === "Refused") return state.outcome;
		if (state.value._tag === "Absent") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${file.display}: the register does not exist — nothing was written. Run "fabrika glossary init --register ${register}" first.`,
			);
		}
		const {text, parsed} = state.value;

		const section = parsed.sections.find((candidate) => candidate.name === options.section);
		if (section === undefined && !(options.createSection && !options.replace)) {
			return refuse(
				SECTION_ABSENT,
				`${VERB}: "${options.section}" is not a section of ${file.display} — run "fabrika glossary sections" for the live list.`,
			);
		}

		const definition = yield* readSource(
			options.definitionFile,
			options.cwd,
			options.stdin,
			"--definition-file",
		);
		if (definition._tag === "Refused") return definition.outcome;
		let notCell = "";
		if (options.notFile !== null) {
			const not = yield* readSource(options.notFile, options.cwd, options.stdin, "--not-file");
			if (not._tag === "Refused") return not.outcome;
			notCell = flattenCell(not.value);
		}

		const plain = [flattenCell(options.term), flattenCell(definition.value), notCell] as const;
		if (plain[1] === "") {
			return refuse(
				ROW_SHAPE_INVALID,
				`${VERB}: the definition is empty after normalization — refusing to write a blank row.`,
			);
		}
		if (plain[0] === "") {
			return refuse(
				ROW_SHAPE_INVALID,
				`${VERB}: the term is empty after normalization — refusing to write a blank row.`,
			);
		}
		const rowText = renderRow(plain.map(escapeCell));

		const key = normalizeKey(plain[0]);
		const declared = parsed.rows.find((row) => row.key === key);
		if (declared !== undefined && !options.replace) {
			return refuse(
				TERM_COLLISION,
				`${VERB}: ${plain[0]} is already declared in ${register} under "${declared.section}" — pass --replace to rewrite it.`,
			);
		}
		if (declared === undefined && options.replace) {
			return refuse(
				TERM_COLLISION,
				`${VERB}: --replace was given and ${plain[0]} is not declared in ${register} — refusing to rewrite a row that does not exist.`,
			);
		}

		const lines = text.split("\n");
		const scope: string[] = [`${VERB}: ${file.display} — ${parsed.rows.length} row(s) read.`];
		let splice: Splice;
		let reportLine: number;
		let reportSection: string;
		let action: "added" | "replaced";

		if (declared !== undefined) {
			splice = {at: declared.line - 1, added: 1, replaced: 1};
			reportLine = declared.line;
			reportSection = declared.section;
			action = "replaced";
		} else if (section !== undefined) {
			if (section.separatorLine === null) {
				return refuse(
					ROW_SHAPE_INVALID,
					`${VERB}: ${file.display} has no parseable table under "${options.section}" — the insertion point is UNKNOWN, nothing written.`,
					scope,
				);
			}
			const placement = placeRow(section, key);
			if (placement.unsorted) {
				scope.push(
					`${VERB}: section "${section.name}" is not in ascending key order — the row was placed to keep it ordered against its neighbours, and nothing else was moved.`,
				);
			}
			splice = {at: placement.index, added: 1, replaced: 0};
			reportLine = placement.index + 1;
			reportSection = section.name;
			action = "added";
		} else {
			const at = appendIndex(lines);
			splice = {at, added: newSectionBlock(options.section, rowText).length, replaced: 0};
			reportLine = at + 5;
			reportSection = options.section;
			action = "added";
		}

		const inserted =
			splice.added === 1 ? [rowText] : [...newSectionBlock(options.section, rowText)];
		const next = [
			...lines.slice(0, splice.at),
			...inserted,
			...lines.slice(splice.at + splice.replaced),
		];

		const beyond = linesChangedBeyond(lines, next, splice);
		if (beyond !== 0) {
			return refuse(
				EDIT_BEYOND_ROW,
				`${VERB}: the edit would have changed ${beyond} line(s) beyond the target row — aborted, nothing written.`,
				scope,
			);
		}

		const nextText = next.join("\n");
		const written = yield* Effect.result(writeFile(file.path, nextText));
		if (Result.isFailure(written)) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: cannot write ${file.display}: ${written.failure.reason} — the register's state is UNKNOWN, re-read it before retrying.`,
				scope,
			);
		}

		const readBack = yield* Effect.result(readFile(file.path));
		const landed =
			Result.isSuccess(readBack) && parseRegister(readBack.success)._tag === "Parsed"
				? readBack.success.split("\n")[reportLine - 1]
				: undefined;
		if (landed !== rowText) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${file.display} and the read-back differs at line ${reportLine} — the register may be inconsistent.`,
				scope,
			);
		}

		if (options.json) {
			return answer(
				JSON.stringify({
					action,
					path: file.display,
					section: reportSection,
					line: reportLine,
					term: plain[0],
					normalized: key,
				}),
				scope,
			);
		}
		return answer(`${action}\t${file.display}\t${reportSection}\t${reportLine}`, scope);
	});
