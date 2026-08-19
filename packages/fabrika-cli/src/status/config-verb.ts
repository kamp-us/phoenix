/**
 * `status config` — which repo surfaces every landed skill declares it needs, and whether each is
 * present here. The detection verb the founder ruled into existence in place of v1's `/doctor`
 * skill (#4952, and the kill ruling #4722 that stands): machine-answerable, exit-coded, zero
 * judgement.
 *
 * **`present` is the only state this verb can prove.** `missing` is a probe that ran and found
 * nothing; `unprobeable` is a subject no probe settles; `unknown` is a probe that could not be
 * performed. Rendering an unprobeable subject `present` off some file's existence is the false
 * positive the four-state set exists to prevent, and scoring an undeclared skill clean is the
 * fail-open of #4060.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import {exists, readFile} from "../io/fs.ts";
import type {Attempt} from "../io/git.ts";
import {answer, type VerbOutcome} from "../verb.ts";
import {type AsOf, asOfToken, detail, EMPTY_CELL, row} from "./fields.ts";
import {rosterRefusal} from "./menu-verb.ts";
import {CANONICAL_DISPOSITIONS, type DeclaredRow, parseRequiredFiles} from "./required-files.ts";
import type {RosterRead, RosterSkill} from "./roster.ts";

const VERB = "status config";

/** The declaration a skill with no `## Required repo files` section carries: nobody checked. */
export const UNDECLARED = "undeclared";

export type Presence = "present" | "missing" | "unprobeable" | "unknown";
export type ConfigState = "satisfied" | "gaps" | "unknown";

export interface SurfaceRow {
	readonly skill: string;
	readonly surfaceId: string;
	readonly disposition: string;
	readonly presence: Presence;
	readonly consequence: string;
	readonly detail: string;
	readonly asOf: AsOf;
}

export interface ConfigCounts {
	readonly declaredSkills: number;
	readonly missing: number;
	readonly undeclaredSkills: number;
	readonly offVocabulary: number;
	readonly unprobeable: number;
	readonly probed: number;
}

/**
 * The label set of the target repo, or the reason it is UNKNOWN.
 *
 * A label probe that could not be *performed* is not the same as a label that is not there, so an
 * unresolvable repo renders every label row `unknown` rather than `missing`.
 */
export type LabelSet =
	| {readonly _tag: "Known"; readonly labels: ReadonlySet<string>}
	| {readonly _tag: "Unknown"; readonly reason: string};

export const labelSetOf = (repo: Attempt<ReadonlyArray<string>> | null): LabelSet =>
	repo === null
		? {_tag: "Unknown", reason: "no repo resolved — the label probe could not be performed"}
		: repo._tag === "Failure"
			? {_tag: "Unknown", reason: repo.reason}
			: {_tag: "Known", labels: new Set(repo.value)};

/**
 * Every row a skill declares — or the single `undeclared` row that a missing section is.
 *
 * Never zero rows: an absent declaration means nobody checked, which is #5049's own stated reason
 * for requiring the section.
 */
export const declaredRowsOf = (skill: RosterSkill): ReadonlyArray<DeclaredRow> | null =>
	parseRequiredFiles(skill.text);

const undeclaredRow = (skill: string, asOf: AsOf): SurfaceRow => ({
	skill,
	surfaceId: EMPTY_CELL,
	disposition: UNDECLARED,
	presence: "unknown",
	consequence: EMPTY_CELL,
	detail: "no `## Required repo files` section",
	asOf,
});

export interface ProbeContext {
	/** The directory a declared path is resolved against — the invocation's repository root. */
	readonly repoRoot: string;
	readonly labels: LabelSet;
	readonly repoName: string;
	readonly asOf: AsOf;
}

/**
 * Probe one declared row's subject. A probe that could not be performed is `unknown`, never `false`.
 *
 * A `PathContaining` subject costs a file read on top of the existence probe, and that is the whole
 * point of the case: its `present` means the declared content is in the file, not that some file of
 * that name is on disk.
 */
export const probeRow = (
	skill: string,
	declared: DeclaredRow,
	ctx: ProbeContext,
): Effect.Effect<SurfaceRow, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const base = {
			skill,
			surfaceId: declared.surfaceId,
			disposition: declared.disposition,
			consequence: detail(declared.consequence),
			asOf: ctx.asOf,
		};
		if (declared.subject._tag === "Unprobeable") {
			return {...base, presence: "unprobeable" as const, detail: detail(declared.subject.reason)};
		}
		if (declared.subject._tag === "Labels") {
			if (ctx.labels._tag === "Unknown") {
				return {...base, presence: "unknown" as const, detail: detail(ctx.labels.reason)};
			}
			const known = ctx.labels.labels;
			const absent = declared.subject.labels.filter((label) => !known.has(label));
			return absent.length === 0
				? {
						...base,
						presence: "present" as const,
						detail: detail(declared.subject.labels.join(",")),
					}
				: {
						...base,
						presence: "missing" as const,
						detail: detail(`no label ${absent.join(",")} in ${ctx.repoName}`),
					};
		}
		const declaredPath = declared.subject.path;
		const absolute = `${ctx.repoRoot}/${declaredPath}`;
		const probe = yield* Effect.result(exists(absolute));
		if (Result.isFailure(probe)) {
			return {...base, presence: "unknown" as const, detail: detail(probe.failure.reason)};
		}
		if (!probe.success) {
			return {
				...base,
				presence: "missing" as const,
				detail: detail(`no ${declaredPath} at the repo root`),
			};
		}
		if (declared.subject._tag === "Path") {
			return {...base, presence: "present" as const, detail: declaredPath};
		}
		const wanted = declared.subject.contains;
		const text = yield* Effect.result(readFile(absolute));
		if (Result.isFailure(text)) {
			return {...base, presence: "unknown" as const, detail: detail(text.failure.reason)};
		}
		return text.success.includes(wanted)
			? {...base, presence: "present" as const, detail: detail(`${declaredPath} covers ${wanted}`)}
			: {
					...base,
					presence: "missing" as const,
					detail: detail(`${declaredPath} does not cover ${wanted}`),
				};
	});

export interface SurfacesInput {
	readonly roster: Extract<RosterRead, {readonly _tag: "Resolved"}>;
	/** `--skill`, when the caller narrowed the scope. */
	readonly only: string | null;
	readonly ctx: ProbeContext;
}

/** Every declared surface across the roster, ordered by skill then the row's order in its table. */
export const probeSurfaces = ({
	roster,
	only,
	ctx,
}: SurfacesInput): Effect.Effect<
	ReadonlyArray<SurfaceRow>,
	never,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const scoped =
			only === null ? roster.skills : roster.skills.filter((skill) => skill.name === only);
		if (only !== null && scoped.length === 0) {
			return [{...undeclaredRow(only, ctx.asOf), detail: "not in the roster"}];
		}
		const out: SurfaceRow[] = [];
		for (const skill of scoped) {
			const declared = declaredRowsOf(skill);
			if (declared === null || declared.length === 0) {
				out.push(undeclaredRow(skill.name, ctx.asOf));
				continue;
			}
			for (const one of declared) out.push(yield* probeRow(skill.name, one, ctx));
		}
		return out;
	});

/**
 * The header counts.
 *
 * `<missing>` **deduplicates by id**, so a surface three skills declare counts once — while every
 * declaring row still prints, so no declaration is hidden. Rows with no id token cannot dedupe
 * against each other and each counts, which is the honest reading while landed skills carry none.
 */
export const countsOf = (surfaces: ReadonlyArray<SurfaceRow>): ConfigCounts => {
	const declaring = new Set<string>();
	const undeclaredSkills = new Set<string>();
	const missingIds = new Set<string>();
	let missingUnidentified = 0;
	let offVocabulary = 0;
	let unprobeable = 0;
	let probed = 0;
	for (const surface of surfaces) {
		if (surface.disposition === UNDECLARED) {
			undeclaredSkills.add(surface.skill);
			continue;
		}
		declaring.add(surface.skill);
		if (!CANONICAL_DISPOSITIONS.includes(surface.disposition)) offVocabulary += 1;
		if (surface.presence === "unprobeable") unprobeable += 1;
		if (surface.presence === "present" || surface.presence === "missing") probed += 1;
		if (surface.presence !== "missing") continue;
		if (surface.surfaceId === EMPTY_CELL) missingUnidentified += 1;
		else missingIds.add(surface.surfaceId);
	}
	return {
		declaredSkills: declaring.size,
		missing: missingIds.size + missingUnidentified,
		undeclaredSkills: undeclaredSkills.size,
		offVocabulary,
		unprobeable,
		probed,
	};
};

/**
 * The header state.
 *
 * `satisfied` requires *proof* for every declared surface, which is why a row-level `unknown`
 * lands under `gaps` alongside `missing`: an unperformed probe is not a present surface, and a
 * detection verb that scored it clean would be the fail-open this verb exists to remove.
 */
export const configState = (
	surfaces: ReadonlyArray<SurfaceRow>,
	skillCount: number,
): ConfigState => {
	if (skillCount === 0) return "gaps";
	return surfaces.every((s) => s.disposition !== UNDECLARED && s.presence === "present")
		? "satisfied"
		: "gaps";
};

export interface ConfigInput {
	readonly roster: RosterRead;
	readonly surfaces: ReadonlyArray<SurfaceRow>;
	readonly json: boolean;
}

export const runConfig = ({roster, surfaces, json}: ConfigInput): VerbOutcome => {
	if (roster._tag !== "Resolved") return rosterRefusal(VERB, roster);
	const counts = countsOf(surfaces);
	const state = configState(surfaces, roster.skills.length);
	const notice = `${VERB}: roster ${roster.display} (${roster.tier}), ${roster.skills.length} skills, ${counts.declaredSkills} declaring, ${counts.undeclaredSkills} undeclared; probed ${counts.probed} surfaces, ${counts.unprobeable} unprobeable.`;

	if (json) {
		return answer(
			`${JSON.stringify({
				outcome: state,
				declaredSkills: counts.declaredSkills,
				missing: counts.missing,
				undeclaredSkills: counts.undeclaredSkills,
				offVocabulary: counts.offVocabulary,
				surfaces: surfaces.map((s) => ({
					skill: s.skill,
					surfaceId: s.surfaceId,
					disposition: s.disposition,
					presence: s.presence,
					consequence: s.consequence,
					detail: s.detail,
					asOf: s.asOf.at,
					asOfKind: s.asOf.kind,
				})),
			})}\n`,
			[notice],
		);
	}
	const lines = [
		row(
			"config",
			state,
			String(counts.declaredSkills),
			String(counts.missing),
			String(counts.undeclaredSkills),
			String(counts.offVocabulary),
		),
		...surfaces.map((s) =>
			row(
				"surface",
				s.skill,
				s.surfaceId,
				s.disposition,
				s.presence,
				s.consequence,
				s.detail,
				asOfToken(s.asOf),
			),
		),
	];
	return answer(`${lines.join("\n")}\n`, [notice]);
};
