/**
 * `lane assembly-pr` — the epic run's PR title and About section, derived and printed one at a time.
 *
 * It opens nothing. The operate skill's `gh pr create` fence stays literal and interpolates this
 * verb's stdout, which is why each `--field` prints a bare value rather than a JSON record: a shell
 * that has to reach into a document to find the title is a shell deriving the title.
 *
 * The About section's absence is an answer, not a failure: an epic with no `## Pitch` still has a
 * run to publish, and blocking that publication over prose would strand the only PR the run opens.
 * So an unpitched epic answers empty stdout with the reason on stderr, and the fence's body simply
 * carries no section. The one refusal on this field is the section that could not be made safe for
 * `build pr`'s body guard, which is a claim about a gated question and a person's to reword.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, openIssue, resolveTargetRepo} from "../build/target.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {aboutSection, assemblyTitle} from "./assembly-pr.ts";
import {ABOUT_UNSAFE, NOT_AN_EPIC} from "./codes.ts";

const VERB = "fabrika lane assembly-pr";

/** The label that makes an issue an epic — the same one `conventionalTitleOf` maps to `feat`. */
const EPIC_LABEL = "type:epic";

export const FIELDS = ["title", "about"] as const;
export type Field = (typeof FIELDS)[number];

export const isField = (value: string): value is Field =>
	(FIELDS as ReadonlyArray<string>).includes(value);

export interface AssemblyPrOptions {
	readonly epic: number;
	readonly field: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runAssemblyPr = ({
	epic,
	field,
	repo,
	env,
}: AssemblyPrOptions): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", epic);
		if (bad !== null) return bad;
		if (!isField(field)) {
			return refuse(FAILED, `${VERB}: --field is one of ${FIELDS.join(", ")}, not "${field}".`);
		}

		const target = yield* resolveTargetRepo(VERB, repo, env);
		if (target._tag === "Refused") return target.outcome;

		const found = yield* openIssue(
			VERB,
			target.repo,
			epic,
			(reason) => `${VERB}: cannot read #${epic}: ${reason} — the epic is UNKNOWN.`,
		);
		if (found._tag === "Refused") return found.outcome;
		const issue = found.issue;

		if (!issue.labels.includes(EPIC_LABEL)) {
			return refuse(
				NOT_AN_EPIC,
				`${VERB}: #${epic} carries no ${EPIC_LABEL} — an assembly PR's prose is an epic's, and a non-epic subject would land on main under a scope it does not have.`,
			);
		}

		if (field === "title") {
			return answer(assemblyTitle(issue.title, issue.labels), [
				`${VERB}: derived from #${epic}'s own title; the conventional type is pr-title.ts's.`,
			]);
		}

		const about = aboutSection(epic, issue.body);
		if (about._tag === "Unsafe") {
			return refuse(
				ABOUT_UNSAFE,
				`${VERB}: #${epic}'s Problem paragraph still carries ${about.what} after neutralisation — build pr's body guard would refuse it. Reword the paragraph, or write the section by hand.`,
			);
		}
		return about._tag === "Unpitched"
			? answer("", [
					`${VERB}: #${epic} ${about.why} — no About section is derivable, so none is printed.`,
				])
			: answer(about.text, [`${VERB}: derived from #${epic}'s \`## Pitch\` Problem paragraph.`]);
	});
