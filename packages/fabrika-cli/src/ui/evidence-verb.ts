/**
 * `ui evidence` — upload the before/after captures, verify every upload, post one SHA-bound PR
 * comment, and read it back.
 *
 * **Evidence is all-or-nothing.** A comment showing three of five surfaces reads as "this is what
 * changed" and lies by omission, so a single failed upload or upload-verification is `17` with
 * nothing posted. That is the one behavior this verb most exists to pin: the upstream capture-side
 * upload channel is typed `never` and silently projects failures away (`../capture/upload.ts`), which
 * ADR 0165 accepted for the *review* side's verdict — here, on the construction side, a failed upload
 * is a refusal.
 *
 * The comment carries the PR's current head SHA in its text and a re-attach posts a **new** comment
 * at the new head: comments are append-only evidence, never edited in place, because evidence at a
 * stale head misleads (#4808's class).
 */
import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {requireSession} from "../build/claim.ts";
import {contentOf, gate} from "../build/content-gate.ts";
import {laneScratchDir} from "../build/scratch-verb.ts";
import {resolveTargetRepo} from "../build/target.ts";
import {designHarnessOr} from "../config/paths.ts";
import {createComment, currentBranch, getComment} from "../io/issues.ts";
import {getPullRequest} from "../io/pulls.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readBytes} from "./bytes.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	CAPTURE_INVALID,
	LANE_NOT_MINE,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UPLOAD_FAILED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {atRoot} from "./conventions.ts";
import {parseHarness} from "./harness.ts";
import {requireUiLane} from "./lane.ts";
import {probe} from "./manifest-verb.ts";
import {decodePng, sha256Of} from "./png.ts";
import {pullHeadRef} from "./pull-head.ts";
import {pairSets, parseSetManifest, type SetCapture} from "./set-manifest.ts";

const VERB = "ui evidence";

export interface UploadTarget {
	readonly surface: string;
	readonly role: "before" | "after";
	readonly fileName: string;
	readonly sha256: string;
	readonly bytes: Uint8Array;
}

export type Upload =
	| {readonly _tag: "Ok"; readonly url: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export type UploadLeg = (target: UploadTarget) => Effect.Effect<Upload>;

export interface EvidenceOptions {
	readonly pr: number;
	readonly before: string | null;
	readonly after: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly tmpRoot: string;
	/** Content-addressed PUT + GET-back into the harness's declared store. */
	readonly storeUpload: (store: string, target: UploadTarget) => Effect.Effect<Upload>;
	/** GitHub's user-attachment endpoint plus a HEAD probe of every returned URL. */
	readonly attachmentUpload: (repo: string, target: UploadTarget) => Effect.Effect<Upload>;
}

/** The posted markdown: one row per surface, before|after side by side, bound to the head SHA. */
export const composeEvidence = (
	pairs: ReadonlyArray<{
		readonly surface: string;
		readonly before: string | null;
		readonly after: string;
	}>,
	head: string,
): string => {
	const rows = pairs.map(({surface, before, after}) =>
		before === null
			? `### \`${surface}\` — new surface\n\n![after](${after})`
			: `### \`${surface}\`\n\n| before | after |\n| --- | --- |\n| ![before](${before}) | ![after](${after}) |`,
	);
	return [`**UI evidence** — rendered at head \`${head}\`.`, "", ...rows].join("\n");
};

const readCapture = (
	capture: SetCapture,
	set: string,
): Effect.Effect<
	| {readonly _tag: "Bytes"; readonly bytes: Uint8Array}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome},
	never,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const read = yield* readBytes(capture.path);
		if (read._tag === "Failed") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read capture "${capture.surface}" in set "${set}": ${read.reason} — nothing was uploaded or posted.`,
				),
			};
		}
		if (sha256Of(read.bytes) !== capture.sha256) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					CAPTURE_INVALID,
					`${VERB}: capture "${capture.surface}" in set "${set}" is invalid (its bytes no longer hash to the manifest's sha256).`,
				),
			};
		}
		const image = decodePng(read.bytes);
		return image._tag === "Invalid"
			? {
					_tag: "Refused" as const,
					outcome: refuse(
						CAPTURE_INVALID,
						`${VERB}: capture "${capture.surface}" in set "${set}" is invalid (${image.detail}).`,
					),
				}
			: {_tag: "Bytes" as const, bytes: read.bytes};
	});

const readSet = (
	dir: string,
	set: string,
): Effect.Effect<
	| {readonly _tag: "Set"; readonly captures: ReadonlyArray<SetCapture>}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome},
	never,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const manifest = yield* readBytes(`${dir}/manifest.json`);
		if (manifest._tag === "Failed") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					BAD_SECTIONS,
					`${VERB}: set "${set}" has no manifest.json — a set without its manifest is not a set; re-run ui render.`,
				),
			};
		}
		const parsed = parseSetManifest(new TextDecoder().decode(manifest.bytes));
		return parsed._tag === "Violation"
			? {
					_tag: "Refused" as const,
					outcome: refuse(
						BAD_SECTIONS,
						`${VERB}: set "${set}"'s manifest.json is not a set manifest: ${parsed.violation}.`,
					),
				}
			: {_tag: "Set" as const, captures: parsed.captures};
	});

export const runEvidence = (
	options: EvidenceOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| Path.Path
	| HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const lane = yield* requireUiLane(
			VERB,
			resolved.repo,
			session.id,
			(detail, number) =>
				`${VERB}: this session does not hold the claim on ${number === null ? "the checked-out branch" : `#${number}`} (${detail}) — the lane is not yours.`,
		);
		if (lane._tag === "Refused") return lane.outcome;

		const pull = yield* getPullRequest(resolved.repo, options.pr);
		if (pull._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read PR #${options.pr}: ${pull.reason} — nothing was uploaded or posted.`,
				lane.notes,
			);
		}
		if (pull._tag === "Absent" || pull.value.state !== "open" || pull.value.merged) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: PR #${options.pr} is proven absent, closed, or merged.`,
				lane.notes,
			);
		}
		const branch = yield* currentBranch;
		const headBranch = yield* pullHeadRef(options.env, resolved.repo, options.pr);
		if (headBranch._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read PR #${options.pr}'s head branch: ${headBranch.reason} — nothing was uploaded or posted.`,
				lane.notes,
			);
		}
		if (headBranch.ref !== branch) {
			return refuse(
				LANE_NOT_MINE,
				`${VERB}: this session does not hold the claim on #${options.pr} (PR #${options.pr} is on "${headBranch.ref}", not the checked-out "${branch ?? "detached HEAD"}") — the lane is not yours.`,
				lane.notes,
			);
		}

		const scratch = laneScratchDir(options.tmpRoot, session.id, lane.number, lane.nonce);
		const after = yield* readSet(`${scratch}/${options.after}`, options.after);
		if (after._tag === "Refused") return after.outcome;
		let beforeCaptures: ReadonlyArray<SetCapture> = [];
		if (options.before !== null) {
			const before = yield* readSet(`${scratch}/${options.before}`, options.before);
			if (before._tag === "Refused") return before.outcome;
			beforeCaptures = before.captures;
		}
		const pairing = pairSets(beforeCaptures, after.captures);
		if (pairing._tag === "Unexplained") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: after-surface "${pairing.surface}" has no before capture and no firstRender mark — an unexplained missing baseline is a hole in the evidence.`,
				lane.notes,
			);
		}

		const declared = yield* designHarnessOr(
			VERB,
			lane.root,
			"where this repo declares its render path is unread — nothing was uploaded or posted.",
		);
		if (declared._tag === "Refused") {
			return refuse(PRECONDITION_UNKNOWN, declared.message, lane.notes);
		}
		const harnessPath = declared.path;

		const harnessProbe = yield* probe(lane.root, harnessPath);
		if (harnessProbe._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${harnessPath}: ${harnessProbe.reason} — nothing was uploaded or posted.`,
				lane.notes,
			);
		}
		let store: string | null = null;
		if (harnessProbe._tag === "Present") {
			const raw = yield* readBytes(atRoot(lane.root, harnessPath));
			if (raw._tag === "Failed") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${harnessPath}: ${raw.reason} — nothing was uploaded or posted.`,
					lane.notes,
				);
			}
			const harness = parseHarness(new TextDecoder().decode(raw.bytes));
			if (harness._tag === "Violation") {
				return refuse(
					BAD_SECTIONS,
					`${VERB}: ${harnessPath} exists but does not satisfy its schema: ${harness.violation}.`,
					lane.notes,
				);
			}
			store = harness.config.evidenceStore;
		}

		const targets: UploadTarget[] = [];
		for (const pair of pairing.pairs) {
			for (const [role, capture] of [
				["before", pair.before],
				["after", pair.after],
			] as const) {
				if (capture === null) continue;
				const read = yield* readCapture(
					capture,
					role === "before" ? (options.before as string) : options.after,
				);
				if (read._tag === "Refused")
					return {...read.outcome, stderr: [...lane.notes, ...read.outcome.stderr]};
				targets.push({
					surface: capture.surface,
					role,
					fileName: `${role}-${capture.surface.replace(/^\/+/, "").replace(/\//g, "-") || "root"}.png`,
					sha256: capture.sha256,
					bytes: read.bytes,
				});
			}
		}

		const uploads = new Map<string, string>();
		const failures: string[] = [];
		for (const target of targets) {
			const outcome = yield* store === null
				? options.attachmentUpload(resolved.repo, target)
				: options.storeUpload(store, target);
			if (outcome._tag === "Failed") {
				failures.push(`${VERB}: ${target.role} capture of "${target.surface}": ${outcome.reason}`);
			} else {
				uploads.set(`${target.role}:${target.surface}`, outcome.url);
			}
		}
		const firstFailure = failures[0];
		if (firstFailure !== undefined) {
			return refuse(
				UPLOAD_FAILED,
				`${VERB}: upload failed for ${failures.length} of ${targets.length} captures (${firstFailure}) — refusing to post partial evidence; a gallery missing its failures is #3925.`,
				[...lane.notes, ...failures],
			);
		}

		const head = pull.value.headSha;
		const body = composeEvidence(
			pairing.pairs.map((pair) => ({
				surface: pair.surface,
				before: pair.before === null ? null : (uploads.get(`before:${pair.surface}`) as string),
				after: uploads.get(`after:${pair.surface}`) as string,
			})),
			head,
		);
		if (isBareAtReference(body)) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the composed comment is a bare @ path reference — write the evidence, not a pointer to it.`,
				lane.notes,
			);
		}
		const scan = scanBody(body);
		const firstLeak = scan.leaks[0];
		if (firstLeak !== undefined) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: the composed comment carries a machine-local path: ${firstLeak.text}.`,
				[...lane.notes, ...renderLeaks(scan.leaks)],
			);
		}

		const posted = yield* createComment(resolved.repo, options.pr, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the post failed: ${posted.reason} — it may or may not have landed; re-read the PR before re-running.`,
				lane.notes,
			);
		}
		const readback = yield* getComment(resolved.repo, posted.value.id);
		if (readback._tag === "Failure") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the comment landed but does not read back as sent — it needs a human eye.`,
				[...lane.notes, `${VERB}: the read-back itself failed: ${readback.reason}.`],
			);
		}
		const seen = contentOf(gate("comment-body", `comment ${posted.value.id}`, readback.value));
		if (normalizeForReadback(seen) !== normalizeForReadback(body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the comment landed but does not read back as sent — it needs a human eye.`,
				lane.notes,
			);
		}
		return answer(
			JSON.stringify({
				answer: "attached",
				pr: options.pr,
				commentId: posted.value.id,
				head,
				surfaces: pairing.pairs.length,
			}),
			[
				...lane.notes,
				`${VERB}: uploaded ${targets.length} capture${targets.length === 1 ? "" : "s"} over ${pairing.pairs.length} surface${pairing.pairs.length === 1 ? "" : "s"}.`,
			],
		);
	});
