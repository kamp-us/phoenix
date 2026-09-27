import {Crypto, Effect, FileSystem, Path, Schema} from "effect";
import {type Attempt, fail, ok} from "../io/git.ts";
import {IssueDocument} from "../io/issue-document.ts";
import {issueDocuments} from "../io/issues.ts";
import {parseJson} from "../io/json.ts";
import {closedCutoff, excerpt, inWindow} from "./issue-index.ts";

export const CACHE_TTL_MS = 300_000;
export class IndexSnapshot extends Schema.Class<IndexSnapshot>("IndexSnapshot")({
	version: Schema.Literal(1),
	repo: Schema.String,
	closedDays: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	fetchedAt: Schema.Number.check(Schema.isFinite()),
	issues: Schema.Array(IssueDocument),
}) {
	usable(repo: string, days: number, now: number): boolean {
		const age = now - this.fetchedAt;
		return this.repo === repo && this.closedDays === days && age >= 0 && age < CACHE_TTL_MS;
	}
}

interface Corpus {
	readonly issues: ReadonlyArray<IssueDocument>;
	readonly cache: {readonly source: "cache" | "fetched"; readonly ageMs: number};
	readonly diagnostics: ReadonlyArray<string>;
}

const publish = Effect.fn("report.index.publish")(function* (
	file: string,
	snapshot: IndexSnapshot,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const temp = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
	yield* fs.makeDirectory(path.dirname(file), {recursive: true, mode: 0o700});
	yield* fs
		.writeFileString(temp, JSON.stringify(snapshot), {mode: 0o600, flag: "wx"})
		.pipe(
			Effect.andThen(fs.rename(temp, file)),
			Effect.ensuring(fs.remove(temp, {force: true}).pipe(Effect.catch(() => Effect.void))),
		);
});

/** @ruling https://github.com/kamp-us/phoenix/issues/6923 */
export const loadIndex = Effect.fn("report.index.load")(function* (
	repo: string,
	days: number,
	now: number,
	refresh: boolean,
	env: Readonly<Record<string, string | undefined>>,
): Effect.fn.Return<
	Attempt<Corpus>,
	never,
	| FileSystem.FileSystem
	| Path.Path
	| Crypto.Crypto
	| import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner
> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = env.XDG_CACHE_HOME ?? (env.HOME ? path.join(env.HOME, ".cache") : null);
	const file =
		root === null
			? null
			: path.join(
					root,
					"fabrika",
					"dedup",
					`${encodeURIComponent(repo.toLowerCase())}-${days}.json`,
				);
	const diagnostics: string[] = [];
	if (file !== null && !refresh) {
		const read = yield* fs.readFileString(file).pipe(Effect.result);
		if (read._tag === "Success") {
			const decoded = yield* Schema.decodeUnknownEffect(IndexSnapshot)(
				parseJson(read.success),
			).pipe(Effect.result);
			if (decoded._tag === "Success" && decoded.success.usable(repo, days, now)) {
				return ok({
					issues: decoded.success.issues.filter((issue) =>
						inWindow(issue, closedCutoff(now, days), days),
					),
					cache: {source: "cache", ageMs: now - decoded.success.fetchedAt},
					diagnostics,
				});
			}
			diagnostics.push("report dedup: invalid or expired cache; fetching the corpus.");
		}
	}
	const open = yield* issueDocuments(repo, {state: "open"});
	if (open._tag === "Failure") return fail(open.reason);
	const cutoff = closedCutoff(now, days);
	const closed =
		days === 0
			? ok<ReadonlyArray<IssueDocument>>([])
			: yield* issueDocuments(repo, {state: "closed", since: closedCutoff(now - 1000, days)});
	if (closed._tag === "Failure") return fail(closed.reason);
	const merged = new Map([...open.value, ...closed.value].map((issue) => [issue.number, issue]));
	const issues = [...merged.values()]
		.filter((issue) => inWindow(issue, cutoff, days))
		.map((issue) => ({...issue, body: excerpt(issue.body)}));
	const snapshot = new IndexSnapshot({version: 1, repo, closedDays: days, fetchedAt: now, issues});
	if (file !== null) {
		const written = yield* publish(file, snapshot).pipe(Effect.result);
		if (written._tag === "Failure")
			diagnostics.push("report dedup: cache write failed; using the fetched corpus for this run.");
	} else
		diagnostics.push(
			"report dedup: no cache directory available; using the fetched corpus for this run.",
		);
	return ok({issues, cache: {source: "fetched", ageMs: 0}, diagnostics});
});
