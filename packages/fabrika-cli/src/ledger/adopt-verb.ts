/**
 * `ledger adopt` — bring an already-filed issue into the plan as a child, instead of minting a
 * near-duplicate of it.
 *
 * Every judgment runs before the first write, so a refusal writes nothing. The writes then run in
 * the order a re-run can finish: the amendment first (an unlinked, unrecorded issue is still just
 * the report it was), the park on `status:planned` second, the manifest record third, the link
 * last — so the issue is never a linked child while it is still pickable. **Each leg is idempotent
 * against the live state rather than against a memory of the last attempt** — the amendment is
 * composed only from field lines the body does not already declare, the park is skipped when the
 * issue no longer carries `status:triaged`, the manifest line is replaced rather than appended, and
 * the link is skipped when the parent endpoint already names this epic — so a refusal after any leg
 * is recovered by running the same command again.
 *
 * The park is its only label write. It writes no milestone, assignee or title, and no other label.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8556#issuecomment-5625029977
 */

import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getParent} from "../build/github.ts";
import {scannedLine} from "../build/target.ts";
import {CONFIG_PATH} from "../config/document.ts";
import {
	CONTAINMENT_VOCABULARY,
	containmentVocabularyKey,
} from "../config/keys/containment-vocabulary.ts";
import {resolve} from "../config/load.ts";
import {loadRepoConfig} from "../config/working-root.ts";
import {addLabels, listLabels, removeLabel} from "../io/issues.ts";
import {PLANNED, TRIAGED} from "../labels.ts";
import {listSubIssues} from "../plan/github.ts";
import {compose} from "../report/amend.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {amendmentSection, judgeAdoption, parseStoriesFlag} from "./adoption.ts";
import {
	LINK_UNPROVEN,
	MANIFEST_UNWRITTEN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {linkSubIssue, patchIssueBodyOver, readAdoptee} from "./github.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import type {ChildRecord} from "./run.ts";
import {appendChild, loadManifest, loadRun, maskedLeakRefusal, rewriteChild} from "./run-io.ts";

const VERB = "ledger adopt";

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to adopt a child into it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was written.`,
};

export interface AdoptOptions extends OpenOptions {
	readonly child: number;
	readonly stories: string | null;
	readonly containment: string | null;
	readonly now: () => Date;
}

const RERUN =
	"re-run the same `ledger adopt` — it re-reads the issue and repeats only what is missing";

export const runAdopt = (
	options: AdoptOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| HttpClient.HttpClient
	| Path.Path
> =>
	Effect.gen(function* () {
		const child = options.child;
		if (!Number.isInteger(child) || child <= 0) {
			return refuse(OFF_VOCABULARY, `${VERB}: --child ${child} is not an issue number.`);
		}
		if (child === options.number) {
			return refuse(OFF_VOCABULARY, `${VERB}: --child names the epic itself.`);
		}
		const stories = options.stories === null ? null : parseStoriesFlag(options.stories);
		if (stories?._tag === "NonConforming") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --stories "${stories.value}" does not conform — bare integers or "none".`,
			);
		}

		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {repo, epic, dir, notes} = ground;

		const run = yield* loadRun(MESSAGES, dir, notes);
		if (run._tag === "Refused") return run.outcome;
		const manifest = yield* loadManifest(MESSAGES, dir, notes);
		if (manifest._tag === "Refused") return manifest.outcome;

		const vocabulary = resolve(yield* loadRepoConfig(options.cwd), containmentVocabularyKey);
		if (vocabulary._tag === "Malformed" || vocabulary._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`${CONFIG_PATH}'s \`${CONTAINMENT_VOCABULARY}\``, vocabulary.reason),
				notes,
			);
		}

		const issue = yield* readAdoptee(options.env, repo, child);
		if (issue._tag === "Unknown") {
			return refuse(PRECONDITION_UNKNOWN, MESSAGES.unreadable(`#${child}`, issue.reason), notes);
		}
		if (issue._tag === "Absent" || issue.value.state !== "open") {
			return refuse(ZERO_SCOPE, `${VERB}: issue #${child} is proven absent or closed.`, notes);
		}
		const adoptee = issue.value;
		if (adoptee.isPullRequest) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: #${child} is a pull request — only an issue can be a child.`,
				notes,
			);
		}

		const parent = yield* getParent(options.env, repo, child);
		if (parent._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`#${child}'s parent`, parent.reason),
				notes,
			);
		}
		if (parent._tag === "Present" && parent.value !== epic.number) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: #${child} is already a sub-issue of #${parent.value} — an issue has one parent, and moving it out of another plan is that plan's decision.`,
				notes,
			);
		}
		const alreadyLinked = parent._tag === "Present";

		const judged = judgeAdoption({
			body: adoptee.body,
			labels: adoptee.labels,
			assignees: adoptee.assignees,
			cycleDoc: run.value.cycleDoc,
			vocabulary: vocabulary.value,
			stories,
			containment: options.containment,
		});
		if (judged._tag === "Refused") {
			return refuse(judged.code, `${VERB}: #${child} cannot be adopted: ${judged.reason}`, notes);
		}

		const ignored =
			options.containment !== null && run.value.cycleDoc !== "present"
				? [
						`${VERB}: --containment is not written — the run's cycle doc reads ${run.value.cycleDoc}.`,
					]
				: [];
		const diagnostics = [
			...notes,
			...ignored,
			scannedLine(VERB, 1, "adopted issue", `${judged.fields.length} field line(s) owed`),
		];

		const addPlanned = judged.park === "owed" && !adoptee.labels.includes(PLANNED);
		if (addPlanned) {
			const taxonomy = yield* listLabels(repo);
			if (taxonomy._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					MESSAGES.unreadable(`${repo}'s label taxonomy`, taxonomy.reason),
					diagnostics,
				);
			}
			if (!taxonomy.value.includes(PLANNED)) {
				return refuse(
					OFF_VOCABULARY,
					`${VERB}: label "${PLANNED}" is absent from ${repo}'s taxonomy — refusing to create it.`,
					diagnostics,
				);
			}
		}

		if (judged.fields.length > 0) {
			const section = amendmentSection(epic.number, judged.fields);
			const leaked = maskedLeakRefusal(VERB, "amendment", section);
			if (leaked !== null) return {...leaked, stderr: [...diagnostics, ...leaked.stderr]};

			const amendment = compose(adoptee.body, section, options.now());
			const written = yield* patchIssueBodyOver(options.env, repo, child, amendment.body);
			if (written._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the amendment to #${child} was attempted and could not be proven: ${written.reason} — UNKNOWN; ${RERUN}.`,
					diagnostics,
				);
			}
			const landed = yield* readAdoptee(options.env, repo, child);
			const body = landed._tag === "Present" ? normalizeForReadback(landed.value.body) : null;
			if (
				body === null ||
				!body.includes(normalizeForReadback(amendment.appended)) ||
				!body.includes(normalizeForReadback(adoptee.body))
			) {
				return refuse(
					READBACK_MISMATCH,
					`${VERB}: amended #${child} and its body does not read back as the prior body plus the amendment — it needs a human eye.`,
					diagnostics,
				);
			}
		}

		if (judged.park === "owed") {
			const added = addPlanned ? yield* addLabels(repo, child, [PLANNED]) : null;
			const removed = yield* removeLabel(repo, child, TRIAGED);
			const parked = yield* readAdoptee(options.env, repo, child);
			if (
				parked._tag !== "Present" ||
				!parked.value.labels.includes(PLANNED) ||
				parked.value.labels.includes(TRIAGED)
			) {
				const failures = [added, removed].flatMap((write) =>
					write?._tag === "Failure" ? [`${VERB}: ${write.reason}.`] : [],
				);
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the park of #${child} on ${PLANNED} was attempted and could not be proven — UNKNOWN; #${child} is not linked; ${RERUN}.`,
					[...diagnostics, ...failures],
				);
			}
		}

		const previous = manifest.value.find((record) => record.number === child);
		const record: ChildRecord = {
			number: child,
			id: adoptee.id,
			title: adoptee.title,
			type: adoptee.labels.find((label) => label.startsWith("type:")) ?? null,
			priority: adoptee.labels.find((label) => /^p\d+$/.test(label)) ?? null,
			readyFor: adoptee.labels.find((label) => label.startsWith("ready-for:")) ?? null,
			stories: judged.stories,
			containment: judged.containment,
			linked: alreadyLinked,
			mintedThisRun: previous?.mintedThisRun ?? false,
		};
		const recorded =
			previous === undefined
				? yield* appendChild(dir, record)
				: yield* rewriteChild(dir, manifest.value, record);
		if (recorded !== null) {
			return refuse(
				MANIFEST_UNWRITTEN,
				`${VERB}: could not write the run manifest: ${recorded} — #${child} is not linked; ${RERUN}.`,
				diagnostics,
			);
		}

		const unlinked = `${VERB}: #${child} is recorded in the run manifest as linked:false and its sub-issue link could not be proven; ${RERUN}.`;
		if (!alreadyLinked) {
			const linked = yield* linkSubIssue(options.env, repo, epic.number, adoptee.id);
			if (linked._tag === "Failure") {
				return refuse(LINK_UNPROVEN, unlinked, [...diagnostics, `${VERB}: ${linked.reason}.`]);
			}
		}
		const siblings = yield* listSubIssues(repo, epic.number, options.env);
		if (siblings._tag === "Failure" || !siblings.value.some((link) => link.number === child)) {
			return refuse(LINK_UNPROVEN, unlinked, [
				...diagnostics,
				`${VERB}: ${siblings._tag === "Failure" ? siblings.reason : `#${child} is not in #${epic.number}'s sub-issue list`}.`,
			]);
		}

		if (!alreadyLinked) {
			const reread = yield* loadManifest(MESSAGES, dir, diagnostics);
			if (reread._tag === "Refused") return reread.outcome;
			const rewritten = yield* rewriteChild(dir, reread.value, {...record, linked: true});
			if (rewritten !== null) {
				return refuse(
					MANIFEST_UNWRITTEN,
					`${VERB}: linked #${child} and could not record the link in the run manifest: ${rewritten}; ${RERUN}.`,
					diagnostics,
				);
			}
		}

		return answer(
			JSON.stringify({
				answer: "adopted",
				epic: epic.number,
				child,
				linked: true,
				link: alreadyLinked ? "already" : "written",
				amended: judged.fields.length > 0,
				park: judged.park === "owed" ? "written" : "already",
				fields: judged.fields,
				stories: judged.stories,
				containment: judged.containment,
			}),
			diagnostics,
		);
	});
