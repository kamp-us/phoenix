/**
 * What all three `campaign` verbs do before they diverge: find the roadmap file, read it, parse it —
 * and, for the two writers, run the approval trace end to end.
 *
 * The trace's order is the contract's most-informative-first precedence made executable:
 * `17` (nobody declared) outranks everything, then the repository binding, then a named-set miss
 * (`16`), then the marker itself (`14`/`15`), then the live ACL (`21`). A caller with a bad selector
 * never reaches any of it — the duplicate and no-op checks run first, so nobody is told their
 * citation is fine on a write that was never going to land.
 */

import {Effect, type FileSystem, Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CampaignRow, type CampaignState, parseCampaigns} from "../build/scope-admission.ts";
import {CONFIG_PATH} from "../config/document.ts";
import {campaignAuthorsKey} from "../config/keys/campaign-authors.ts";
import {grantAuthorText} from "../config/keys/cap-clear-authors.ts";
import {readRoadmapFile} from "../config/paths.ts";
import {readKey} from "../config/read-key.ts";
import {discoverRepoRoot} from "../delegate/root.ts";
import {readFile} from "../io/fs.ts";
import {getCommentRecord} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {aclOf, declaredBy} from "./authority.ts";
import {
	AUTHOR_UNDECLARED,
	AUTHORITY_UNKNOWN,
	BELOW_WRITE_FLOOR,
	CONFIG_UNREADABLE,
	MARKER_UNBOUND,
	NO_MARKER,
	NOBODY_DECLARED,
	PRECONDITION_UNKNOWN,
	TABLE_UNREADABLE,
} from "./codes.ts";
import {bindingMiss, readMarker} from "./marker.ts";

/** What a verb that only touches the working tree needs — `campaign list` never reaches the board. */
export type FileEffect<A> = Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>;

/** {@link FileEffect} plus the spawner the credential resolution shells out for. */
export type CampaignEffect<A> = Effect.Effect<
	A,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
>;

/** The roadmap file to open, and the spelling every message names it by. */
export interface Located {
	readonly path: string;
	readonly display: string;
}

export type LocateRead =
	| {readonly _tag: "File"; readonly located: Located}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * Where the roadmap is: `--file` as typed, else the repo's declared `roadmapFile` under its root.
 *
 * `roadmapFile` is a plain path key with no declined form, so a config that will not decode is `22`
 * and no file is opened — never a silent fall back to `ROADMAP.md`, which would validate one file
 * while the fence read another.
 */
export const locateRoadmap = (
	verb: string,
	cwd: string,
	explicit: string | null,
): FileEffect<LocateRead> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		if (explicit !== null) {
			return {
				_tag: "File" as const,
				located: {path: path.resolve(cwd, explicit), display: explicit},
			};
		}
		const declared = yield* readRoadmapFile(cwd);
		if (declared._tag === "Refused") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					CONFIG_UNREADABLE,
					`${verb}: cannot resolve roadmapFile from ${CONFIG_PATH}: ${declared.reason.replace(/\.$/, "")} — UNKNOWN, no roadmap file was opened.`,
				),
			};
		}
		const root = yield* discoverRepoRoot(cwd).pipe(
			Effect.catchTag("fabrika-cli/ReadFailed", () => Effect.succeed(undefined)),
		);
		if (root === undefined) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read ${declared.value}: no repo root at or above ${cwd} — UNKNOWN, nothing was attempted.`,
				),
			};
		}
		return {
			_tag: "File" as const,
			located: {path: path.join(root, declared.value), display: declared.value},
		};
	});

/** What every refusal past a write-verb read states it did not do. */
const NOTHING = "NOTHING was written.";

export type TableRead =
	| {
			readonly _tag: "Text";
			readonly text: string;
			readonly rows: ReadonlyArray<CampaignRow>;
	  }
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * The roadmap's bytes, with the table proven parseable — `11` unread, `12` unreadable.
 *
 * `didNot` is what this verb did not do, and every refusal past a read states it: a refusal that
 * leaves the caller guessing whether a row landed is the one that makes them write a second.
 */
export const readRoadmap = (
	verb: string,
	located: Located,
	didNot: "nothing was parsed" | "nothing was written",
): FileEffect<TableRead> =>
	readFile(located.path).pipe(
		Effect.map((text): TableRead => {
			const parsed = parseCampaigns(text);
			const tail = didNot === "nothing was written" ? ` ${NOTHING}` : "";
			return parsed._tag === "Malformed"
				? {
						_tag: "Refused",
						outcome: refuse(
							TABLE_UNREADABLE,
							`${verb}: ${located.display}: ${parsed.reason} — the whole ## Campaigns table is unreadable (ADR 0304).${tail}`,
						),
					}
				: {_tag: "Text", text, rows: parsed.rows};
		}),
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed<TableRead>({
				_tag: "Refused",
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read ${located.display}: ${failure.reason} — UNKNOWN, ${didNot}.`,
				),
			}),
		),
	);

export interface TraceRequest {
	readonly verb: string;
	readonly cwd: string;
	readonly repo: string;
	/** The citation as typed, already proven to be a comment URL. */
	readonly url: string;
	readonly urlRepo: string;
	readonly commentId: number;
	/** The milestone of the row being written. */
	readonly milestone: number;
	/** The state the write produces — `paused` for `open`, `--to` for `state`. */
	readonly state: CampaignState;
	/** What an empty `campaignAuthors` says nobody may do: `declare` for `open`, `flip` for `state`. */
	readonly act: "declare" | "flip";
}

export type Trace =
	| {
			readonly _tag: "Approved";
			readonly login: string;
			readonly level: string;
			/** `campaignAuthors` as the file spells it, for the notice line. */
			readonly declared: string;
	  }
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

export const runTrace = (request: TraceRequest): CampaignEffect<Trace> =>
	Effect.gen(function* () {
		const {verb, url} = request;
		const no = (code: number, reason: string): Trace => ({
			_tag: "Refused",
			outcome: refuse(code, `${verb}: ${reason} — ${NOTHING}`),
		});
		// The UNKNOWN family reads "— authority is UNKNOWN, NOTHING was written." on one dash: a
		// second em dash before the disclosure would split one sentence into two claims.
		const unreadable = (reason: string): Trace => ({
			_tag: "Refused",
			outcome: refuse(AUTHORITY_UNKNOWN, `${verb}: ${reason} — authority is UNKNOWN, ${NOTHING}`),
		});

		const key = yield* readKey(request.cwd, campaignAuthorsKey);
		if (key._tag === "Refused") {
			return unreadable(
				`cannot read campaignAuthors from ${CONFIG_PATH}: ${key.reason.replace(/\.$/, "")}`,
			);
		}
		if (key.value.length === 0) {
			return {
				_tag: "Refused",
				outcome: refuse(
					NOBODY_DECLARED,
					`${verb}: campaignAuthors is empty in ${CONFIG_PATH} — nobody may ${request.act} a campaign in this repo. ${NOTHING}`,
				),
			};
		}
		const declared = key.value.map(grantAuthorText).join(", ");

		if (request.urlRepo !== request.repo) {
			return no(MARKER_UNBOUND, `${url} is a comment in ${request.urlRepo}, not ${request.repo}`);
		}

		const comment = yield* getCommentRecord(request.repo, request.commentId);
		if (comment._tag === "Failure") {
			return unreadable(`cannot fetch ${url}: ${comment.reason}`);
		}
		const login = comment.value.author;

		const inSet = yield* declaredBy(key.value, login);
		if (inSet._tag === "Unknown") {
			return unreadable(inSet.reason);
		}
		if (inSet._tag === "No") {
			return no(
				AUTHOR_UNDECLARED,
				`${url} was authored by @${login}, who is not in campaignAuthors (${declared})`,
			);
		}

		const marker = readMarker(comment.value.body);
		if (marker._tag === "Absent") {
			return no(NO_MARKER, `${url} has no campaign-approve: marker on its first line`);
		}
		if (marker._tag === "Malformed") {
			return no(MARKER_UNBOUND, `${url} marker is malformed: ${marker.reason}`);
		}
		const miss = bindingMiss(marker.marker, request.milestone, request.state);
		if (miss !== null) return no(MARKER_UNBOUND, `${url} ${miss}`);

		const acl = yield* aclOf(request.repo, login);
		if (acl._tag === "Unknown") {
			return unreadable(acl.reason);
		}
		if (acl._tag === "BelowFloor") {
			return no(
				BELOW_WRITE_FLOOR,
				`${url} was authored by @${login}, who resolves to ${acl.level ?? "no collaboration"} on ${request.repo}, below write — authority is the ACL's, never ${CONFIG_PATH}'s alone (ADR 0055)`,
			);
		}
		return {_tag: "Approved", login, level: acl.level, declared};
	});
