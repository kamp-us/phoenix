/**
 * `ledger child` — mint one child with every birth attribute in one create, link it, re-read it,
 * record it.
 *
 * **The manifest append sits before the link, deliberately.** A child recorded before its link is a
 * child a successor can find and name, which is the whole of what the record buys — and it is enough,
 * because the alternative is an issue that exists on GitHub and appears in no artifact this run
 * produced. Under the reverse order a `23` leaves an issue that is absent from the manifest and can
 * therefore be neither placed (`24`, dangling) nor retired (`10`, not a sub-issue) — created,
 * unusable, and unreachable by every other verb in the group.
 *
 * `--ready-for` is required and has no default (#4780); `--ready-for human` requires `--assignee`
 * (#4693) — the label is the routing signal, born-assignment is the enforced hold, and neither
 * substitutes for the other. That pair is not merely a convention: the gate's floor reds
 * `HELD_CHILD_UNASSIGNED` over the **whole epic**, so one held-and-unassigned child blocks every
 * sibling.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readAuthored} from "../build/authored.ts";
import {scannedLine} from "../build/target.ts";
import {listLabels, listOpenMilestones} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {PLANNED} from "../labels.ts";
import {listSubIssues} from "../plan/github.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {composeChildBody} from "./child-body.ts";
import {
	BAD_SECTIONS,
	LINK_UNPROVEN,
	MANIFEST_UNWRITTEN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {createChildIssue, linkSubIssue, readChildBack} from "./github.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import type {ChildRecord} from "./run.ts";
import {appendChild, loadManifest, loadRun, maskedLeakRefusal, rewriteChild} from "./run-io.ts";

const VERB = "ledger child";

export const TYPES: ReadonlyArray<string> = [
	"type:bug",
	"type:feature",
	"type:chore",
	"type:decision",
	"type:investigation",
];

/** `p3` is retired, not admitted (#4101, #2413). */
export const PRIORITIES: ReadonlyArray<string> = ["p0", "p1", "p2"];

export const AUDIENCES: ReadonlyArray<string> = ["human", "agent"];

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to mint a child of it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was created.`,
};

export interface ChildOptions extends OpenOptions {
	readonly title: string;
	readonly type: string;
	readonly priority: string;
	/** Optional at the parser and refused here: an absent value is a decision nobody made (#4780). */
	readonly readyFor: string | null;
	readonly assignee: string | null;
	readonly milestone: string | null;
	readonly labels: ReadonlyArray<string>;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runChild = (
	options: ChildOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		if (options.readyFor === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --ready-for is required — a child must never inherit its audience by omission (#4780).`,
			);
		}
		if (!AUDIENCES.includes(options.readyFor)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --ready-for ${options.readyFor} is off the closed set (${AUDIENCES.join(", ")}).`,
			);
		}
		if (options.readyFor === "human" && (options.assignee ?? "").trim() === "") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --ready-for human requires --assignee — a held child is born assigned (#4693).`,
			);
		}
		if (!TYPES.includes(options.type)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --type ${options.type} is off the closed set (${TYPES.join(", ")}).`,
			);
		}
		if (!PRIORITIES.includes(options.priority)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --priority ${options.priority} is off the closed set (${PRIORITIES.join(", ")}).`,
			);
		}

		const authored = readAuthored(
			{
				verb: VERB,
				emptyMessage: `${VERB}: stdin held nothing — there is no child body to compose.`,
				bareAtMessage: `${VERB}: the child body carries a bare @ path reference — it cannot be redacted.`,
			},
			yield* options.stdin,
		);
		if (authored._tag === "Refused") return authored.outcome;

		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {repo, epic, dir, notes} = ground;

		const run = yield* loadRun(MESSAGES, dir, notes);
		if (run._tag === "Refused") return run.outcome;

		const composed = composeChildBody({
			text: authored.text,
			cycleDoc: run.value.cycleDoc,
			type: options.type,
		});
		if (composed._tag === "Bad") return refuse(BAD_SECTIONS, `${VERB}: ${composed.reason}`, notes);

		const leaked = maskedLeakRefusal(VERB, "child body", composed.body);
		if (leaked !== null) return {...leaked, stderr: [...notes, ...leaked.stderr]};

		const labels = [
			options.type,
			options.priority,
			PLANNED,
			`ready-for:${options.readyFor}`,
			...options.labels,
		];
		const taxonomy = yield* listLabels(repo);
		if (taxonomy._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`${repo}'s label taxonomy`, taxonomy.reason),
				notes,
			);
		}
		for (const label of labels) {
			if (taxonomy.value.includes(label)) continue;
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: label "${label}" is absent from ${repo}'s taxonomy — refusing to create it (#4285).`,
				notes,
			);
		}

		let milestone: number | null = null;
		if (options.milestone !== null) {
			const milestones = yield* listOpenMilestones(repo);
			if (milestones._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					MESSAGES.unreadable(`${repo}'s open milestones`, milestones.reason),
					notes,
				);
			}
			const found = milestones.value.find((row) => row.title === options.milestone);
			if (found === undefined) {
				return refuse(
					OFF_VOCABULARY,
					`${VERB}: milestone "${options.milestone}" is not an open milestone of ${repo}.`,
					notes,
				);
			}
			milestone = found.number;
		}

		const assignees = options.assignee === null ? [] : [options.assignee];
		const scanned = scannedLine(VERB, labels.length, "label", `taxonomy of ${repo} checked`);
		const diagnostics = [...notes, scanned];

		const created = yield* createChildIssue(repo, {
			title: options.title,
			body: composed.body,
			labels,
			milestone,
			assignees,
		});
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the create was attempted and its outcome could not be proven: ${created.reason} — UNKNOWN.`,
				diagnostics,
			);
		}
		const child = created.value;

		const record: ChildRecord = {
			number: child.number,
			id: child.id,
			title: options.title,
			type: options.type,
			priority: options.priority,
			readyFor: options.readyFor,
			stories: composed.stories,
			containment: composed.containment,
			linked: false,
			mintedThisRun: true,
		};
		const recorded = yield* appendChild(dir, record);
		if (recorded !== null) {
			return refuse(
				MANIFEST_UNWRITTEN,
				`${VERB}: created #${child.number} and could not write the run manifest: ${recorded} — the child exists and this run holds no record of it.`,
				diagnostics,
			);
		}

		const unlinked = `${VERB}: created #${child.number} and could not prove the sub-issue link — the child exists, is recorded in the run manifest as linked:false, and is unlinked on GitHub.`;
		const linked = yield* linkSubIssue(repo, epic.number, child.id);
		if (linked._tag === "Failure") {
			return refuse(LINK_UNPROVEN, unlinked, [...diagnostics, `${VERB}: ${linked.reason}.`]);
		}

		const observed = yield* readChildBack(repo, child.number);
		if (observed._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: created #${child.number} and could not re-read it — the outcome is UNKNOWN.`,
				diagnostics,
			);
		}

		const siblings = yield* listSubIssues(repo, epic.number);
		if (
			siblings._tag === "Failure" ||
			!siblings.value.some((link) => link.number === child.number)
		) {
			return refuse(LINK_UNPROVEN, unlinked, [
				...diagnostics,
				`${VERB}: ${siblings._tag === "Failure" ? siblings.reason : `#${child.number} is not in #${epic.number}'s sub-issue list`}.`,
			]);
		}

		const sentLabels = [...labels].sort();
		const mismatch =
			sentLabels.join(",") !== [...observed.value.labels].join(",") ||
			[...assignees].sort().join(",") !== [...observed.value.assignees].join(",") ||
			(options.milestone ?? null) !== observed.value.milestone;
		if (mismatch) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: created #${child.number} and it does not read back as sent — it needs a human eye.`,
				[
					...diagnostics,
					`${VERB}: sent labels ${sentLabels.join(", ")}; observed ${observed.value.labels.join(", ")}.`,
				],
			);
		}

		const manifest = yield* loadManifest(MESSAGES, dir, diagnostics);
		if (manifest._tag === "Refused") return manifest.outcome;
		const rewritten = yield* rewriteChild(dir, manifest.value, {...record, linked: true});
		if (rewritten !== null) {
			return refuse(
				MANIFEST_UNWRITTEN,
				`${VERB}: created #${child.number} and could not write the run manifest: ${rewritten} — the child exists and this run holds no record of it.`,
				diagnostics,
			);
		}

		return answer(
			JSON.stringify({
				answer: "minted",
				epic: epic.number,
				child: child.number,
				linked: true,
				observed: {
					labels: observed.value.labels,
					assignees: observed.value.assignees,
					milestone: observed.value.milestone,
				},
				stories: composed.stories,
				containment: composed.containment,
			}),
			diagnostics,
		);
	});
