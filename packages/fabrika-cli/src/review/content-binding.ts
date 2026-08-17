/**
 * The content digest a verdict binds: the first 12 lowercase hex of the SHA-256 of a canonical
 * serialization of `git diff --raw base...head`.
 *
 * **What it covers, in terms a reader can falsify.** One raw record per changed path names the
 * path, the change letter, both modes and **both blob object names** — the source blob in the merge
 * base and the destination blob at the head. So a digest over those records binds two things at
 * once, which is exactly the pair ruled on #5508 (ADR 0276): the **three-dot diff**, because a
 * unified diff is a function of the endpoint blobs and the pinned flags and of nothing else, and
 * the **resulting content of every changed file**, because the destination blob *is* that content.
 * Nothing here reads a blob's bytes — the object names are the content, and comparing them is what
 * keeps this cheap enough to run at every gate.
 *
 * **The one thing it deliberately does not cover, and why that is the ruled trade.** A path the
 * head does not touch has no raw record, so a change to it on the base branch leaves this digest
 * equal. That is the residual ADR 0276 accepts out loud: a verdict survives base movement that
 * misses every reviewed path, and dies on base movement that reaches one. It is not free — see the
 * ADR's residual-risk section, which is the single place that argument lives.
 *
 * **A digest that could not be computed is never a digest.** Every failure below resolves to a
 * reason, never to an empty serialization, because an empty one hashes to a perfectly well-formed
 * value that two unrelated heads would share.
 *
 * **Two scopes, one serialization.** The PR scope binds a head; the range scope (#5825) binds what
 * a child's `<base>...<tip>` changed, and survives that range being merged into an epic branch
 * where those SHAs are no longer the history. Both hash the same records the same way — the range
 * half adds only the judged paths, which is what lets a later state be asked the same question.
 */

import {createHash} from "node:crypto";
import {Effect} from "effect";
import {type Attempt, type CommitRange, diffRangeRaw, fail, ok, type Shell} from "../io/git.ts";
import type {NonEmptyReadonlyArray} from "../wire/format.ts";

/** One `git diff --raw` record: a changed path with both endpoints of its change. */
export interface ChangedRecord {
	/** git's own letter — `A`, `M`, `D`, `T`, `R<score>`, `C<score>`. Never normalized. */
	readonly status: string;
	readonly srcMode: string;
	readonly dstMode: string;
	readonly srcOid: string;
	readonly dstOid: string;
	/** The source path of a rename or copy; `null` for every other change. */
	readonly srcPath: string | null;
	/** The path that exists at the head — the destination side of a rename or copy. */
	readonly path: string;
}

export const DIGEST_LENGTH = 12;

/** The one shape a marker's content field accepts, so a mistyped value refuses before any compare. */
export const CONTENT_DIGEST_RE = /^[0-9a-f]{12}$/;

const RECORD = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z]\d*)$/;

/**
 * Split a NUL-separated `--raw -z` stream into records, or say why it is not one.
 *
 * The walk is stateful because a rename or copy carries two path fields where every other change
 * carries one; a chunk-of-two walk shifts every later record by a field and yields a well-formed
 * record list naming the wrong paths. A field that is not a record header is a refusal rather than
 * a skip — a stream this cannot fully account for must not hash to a value.
 */
export const parseRaw = (stdout: string): ReadonlyArray<ChangedRecord> | string => {
	const fields = stdout.split("\0").filter((field) => field !== "");
	const rows: ChangedRecord[] = [];
	for (let i = 0; i < fields.length; ) {
		const matched = RECORD.exec(fields[i] ?? "");
		if (matched === null) {
			return `field ${i + 1} is not a "--raw" record header: "${(fields[i] ?? "").slice(0, 80)}"`;
		}
		const status = matched[5] ?? "";
		const renamed = status.startsWith("R") || status.startsWith("C");
		const first = fields[i + 1];
		const second = renamed ? fields[i + 2] : undefined;
		if (first === undefined || (renamed && second === undefined)) {
			return `record ${rows.length + 1} (${status}) names no ${renamed ? "destination" : ""} path`;
		}
		rows.push({
			status,
			srcMode: matched[1] ?? "",
			dstMode: matched[2] ?? "",
			srcOid: matched[3] ?? "",
			dstOid: matched[4] ?? "",
			srcPath: renamed ? first : null,
			path: renamed ? (second ?? "") : first,
		});
		i += renamed ? 3 : 2;
	}
	return rows;
};

const recordLine = (record: ChangedRecord): string =>
	[
		record.status,
		`${record.srcMode}>${record.dstMode}`,
		`${record.srcOid}>${record.dstOid}`,
		record.srcPath === null ? record.path : `${record.srcPath}>${record.path}`,
	].join("|");

/**
 * The canonical serialization: one record line per changed path, ascending by that line.
 *
 * Sorted rather than taken in git's order because the same two trees must serialize identically
 * however the read reached them; an order-sensitive serialization would make a digest that depends
 * on a git version rather than on the content.
 */
export const serializeContent = (records: ReadonlyArray<ChangedRecord>): string =>
	records.map(recordLine).sort().join("\n");

export const contentDigest = (records: ReadonlyArray<ChangedRecord>): string =>
	createHash("sha256")
		.update(serializeContent(records), "utf8")
		.digest("hex")
		.slice(0, DIGEST_LENGTH);

const recordsAt = (
	range: CommitRange,
	paths: ReadonlyArray<string> = [],
): Shell<Attempt<ReadonlyArray<ChangedRecord>>> =>
	Effect.gen(function* () {
		const raw = yield* diffRangeRaw(range.base, range.tip, paths);
		if (raw._tag === "Failure") return raw;
		const parsed = parseRaw(raw.value);
		return typeof parsed === "string" ? fail(`unreadable --raw stream: ${parsed}`) : ok(parsed);
	});

/**
 * The digest of `base...head`, read from the object database with nothing checked out.
 *
 * An empty range is a `Failure`: a PR with no changed path is the zero-scope state every gate in
 * this package refuses (ADR 0092), and hashing its empty serialization would mint one shared value
 * that every such PR's verdict would bind to.
 */
export const contentDigestAt = (base: string, head: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const parsed = yield* recordsAt({base, tip: head});
		if (parsed._tag === "Failure") return parsed;
		return parsed.value.length === 0
			? fail(`${base}...${head} changes no path — an empty range digests to nothing`)
			: ok(contentDigest(parsed.value));
	});

/**
 * Every path a record set names, **both** sides of a rename, deduplicated and ordered.
 *
 * Both sides because a later state is asked about these paths under a pathspec: limit a renamed
 * change to its destination alone and git has no source to detect the rename from, so the record
 * comes back as an add and the digest moves for a change nobody made.
 */
export const judgedPaths = (records: ReadonlyArray<ChangedRecord>): ReadonlyArray<string> =>
	[
		...new Set(records.flatMap((r) => (r.srcPath === null ? [r.path] : [r.srcPath, r.path]))),
	].sort();

/** What a range verdict binds: the digest of what the range changed, and the paths it changed. */
export interface RangeContent {
	readonly digest: string;
	readonly paths: NonEmptyReadonlyArray<string>;
}

/**
 * What a child's range changed — the pair a range verdict carries into the world (#5825).
 *
 * The digest is the ADR 0276 serialization over `<base>...<tip>` and nothing else, so a range
 * verdict and a PR verdict over the same two commits carry the same twelve hex. The paths ride
 * along because the marker cannot: a verdict names a range and a digest, and re-deriving that
 * digest from a *later* state needs the pathspec the digest was taken under.
 */
export const rangeContentAt = (range: CommitRange): Shell<Attempt<RangeContent>> =>
	Effect.gen(function* () {
		const parsed = yield* recordsAt(range);
		if (parsed._tag === "Failure") return parsed;
		const paths = judgedPaths(parsed.value);
		const [first, ...rest] = paths;
		return first === undefined
			? fail(`${range.base}...${range.tip} changes no path — an empty range digests to nothing`)
			: ok({digest: contentDigest(parsed.value), paths: [first, ...rest] as const});
	});

/**
 * What a later state derived over the judged paths — the three answers the in-force rule folds.
 *
 * `Unchanged` is separate from `Unreadable` because they are opposite facts: the first is git
 * answering that the state carries none of the judged change (a reverted or never-landed merge),
 * the second is git not answering at all. Fold them and a dropped change reports as a broken
 * checkout, which is the one thing an operator reading the refusal needs told apart.
 */
export type Derivation =
	| {readonly _tag: "Digest"; readonly digest: string}
	| {readonly _tag: "Unchanged"}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * The judged content re-derived from `state` — `<base>...<state>` limited to the judged paths.
 *
 * The pathspec is what makes this a *range* answer rather than a branch answer: the epic branch
 * carries every other child's work too, and an unlimited read would digest all of it and move for
 * every sibling merge. Limited to the paths this verdict judged, the answer moves only when this
 * verdict's own content moves.
 */
export const rangeDigestOnto = (
	base: string,
	state: string,
	paths: NonEmptyReadonlyArray<string>,
): Shell<Derivation> =>
	Effect.gen(function* () {
		const parsed = yield* recordsAt({base, tip: state}, paths);
		if (parsed._tag === "Failure") return {_tag: "Unreadable" as const, reason: parsed.reason};
		return parsed.value.length === 0
			? {_tag: "Unchanged" as const}
			: {_tag: "Digest" as const, digest: contentDigest(parsed.value)};
	});

/**
 * Whether a range verdict still binds the state that claims it — the range half of ADR 0276.
 *
 * The PR-scoped rule can lean on head equality first, and a range verdict has no such shortcut: the
 * SHAs it names stop being the epic branch's history the moment the range is merged in, so content
 * is the only thing left to compare. That is why `../wire/range-verdict-marker.ts` makes the digest
 * mandatory where the PR-scoped marker leaves it optional — for a range, absence of a binding would
 * leave nothing at all to judge.
 *
 * Same three arms as `bindToContent`, and the same non-folding: a derivation that could not be made
 * is `Unbindable`, never `Current` and never `Stale`.
 */
export type RangeBinding =
	| {readonly _tag: "Current"; readonly digest: string}
	| {readonly _tag: "Stale"; readonly claimed: string; readonly found: string | null}
	| {readonly _tag: "Unbindable"; readonly reason: string};

export const bindRange = (claim: {readonly content: string}, derived: Derivation): RangeBinding => {
	if (!CONTENT_DIGEST_RE.test(claim.content)) {
		return {
			_tag: "Unbindable",
			reason: `"${claim.content}" is not a content digest — the range verdict's binding cannot be judged`,
		};
	}
	if (derived._tag === "Unreadable") {
		return {
			_tag: "Unbindable",
			reason: `the verdict binds content ${claim.content}, but this state's digest could not be derived: ${derived.reason}`,
		};
	}
	if (derived._tag === "Unchanged") {
		return {_tag: "Stale", claimed: claim.content, found: null};
	}
	return derived.digest === claim.content
		? {_tag: "Current", digest: derived.digest}
		: {_tag: "Stale", claimed: claim.content, found: derived.digest};
};
