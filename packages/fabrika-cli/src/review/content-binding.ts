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
 */

import {createHash} from "node:crypto";
import {Effect} from "effect";
import {type Attempt, diffRangeRaw, fail, ok, type Shell} from "../io/git.ts";

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

/**
 * The digest of `base...head`, read from the object database with nothing checked out.
 *
 * An empty range is a `Failure`: a PR with no changed path is the zero-scope state every gate in
 * this package refuses (ADR 0092), and hashing its empty serialization would mint one shared value
 * that every such PR's verdict would bind to.
 */
export const contentDigestAt = (base: string, head: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const raw = yield* diffRangeRaw(base, head);
		if (raw._tag === "Failure") return raw;
		const parsed = parseRaw(raw.value);
		if (typeof parsed === "string") return fail(`unreadable --raw stream: ${parsed}`);
		return parsed.length === 0
			? fail(`${base}...${head} changes no path — an empty range digests to nothing`)
			: ok(contentDigest(parsed));
	});
