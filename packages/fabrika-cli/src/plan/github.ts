/**
 * The two GitHub reads this gate needs that no shipped module already makes, plus the repo-file probe
 * `MISSING_CONTAINMENT` rests on. Everything else is imported (`io/issues.ts`, `build/target.ts`).
 *
 * Both reads keep the package's two standing disciplines, which is why they are here rather than
 * inline in a verb:
 *
 * - **A shape that is not what was asked for is a failure, never an empty result.** A sub-issue list
 *   that decodes to something else fails; it never reads back as "this epic has no children", which
 *   would turn a broken read into a clean zero-scope refusal about a real ledger.
 * - **Absence is decided by HTTP status, never by matching text against an error string.** v1 used
 *   `/404|not found/i.test(stderr)`, which reads an auth-hidden repo as a proven-absent issue. Since
 *   the port off `gh` (ADR 0315) the status is a number the response carried.
 *
 * The credential is an argument to every leg of the client, so each read resolves one from the `env`
 * its caller hands down — never from `process`, which is what keeps a test's environment scripted.
 *
 * **Why the child read is not `getIssue`.** `IssueRecord` drops the payload's `assignees` key
 * entirely, and the distinction `UNVERIFIABLE_ASSIGNEE` rests on is exactly *the key was not there* —
 * a fact no shape that omits the field can carry. {@link ChildPayload} is that shape: a sibling of
 * `io/issues.ts`'s readers, decoded from the same endpoint, one fetch per child.
 */

import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {existenceOf, pagedWithLinkProof, resolveToken, restRead} from "../io/gh-api.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {type Existence, unknown} from "../io/issues.ts";
import {isRecord} from "../io/json.ts";
import type {CycleDoc} from "./model.ts";

/** An authenticated GitHub read: the transport, plus the spawner the `gh auth token` leg needs. */
type Authed<A> = Effect.Effect<
	A,
	never,
	HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
>;

/** The environment a read resolves its credential from — the caller's, never `process`'s. */
type Env = Readonly<Record<string, string | undefined>>;

/**
 * The cycle doc the containment class is gated on, at the target repository's root, as this package
 * ships it.
 *
 * Where a repo actually keeps it is `cycleDoc` in `.fabrika.jsonc`
 * (`../config/keys/paths.ts`), resolved by the verb and handed to {@link probeCycleDoc}. This
 * constant is that key's shipped default, re-exported from the one place it is written.
 */
export {SHIPPED_CYCLE_DOC as CYCLE_DOC_PATH} from "../config/keys/paths.ts";

/** One native sub-issue link: the child's number plus the open/closed facts the payload carries. */
export interface SubIssueLink {
	readonly number: number;
	readonly state: "open" | "closed";
	readonly stateReason: string | null;
}

/**
 * The epic's children, from the **native sub-issue link list**, paginated in full.
 *
 * Typed JSON off the response rather than `--jq`: `-r` errored mid-stream on a control character in a
 * title and read back as an empty body, which for a child list is a false "no children".
 *
 * Each entry must carry a readable `state` — an entry without one fails the whole read rather than
 * defaulting to open, because a silently-defaulted state is exactly how `lane emit` booted closed
 * children as `queued` (#5746).
 *
 * **A walk that never reached a terminal page fails.** `gh api --paginate`'s stdout could stop
 * mid-page, and `pagedJson` refused those bytes; the HTTP walk's equivalent is a `rel="next"` still
 * outstanding at the page cap. Both are one refusal: a child list nobody proved was all of it must
 * not read back as a shorter ledger.
 */
export const listSubIssues = (
	repo: string,
	epic: number,
	env: Env,
): Authed<Attempt<ReadonlyArray<SubIssueLink>>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		const read = yield* pagedWithLinkProof(token.value, `repos/${repo}/issues/${epic}/sub_issues`);
		if (read._tag === "Failure") return read;
		if (!read.value.exhausted) {
			return fail(
				`the sub-issue list of #${epic} did not reach a terminal page — ${read.value.entries.length} entr(ies) read, with more still declared`,
			);
		}
		const links: SubIssueLink[] = [];
		for (const value of read.value.entries) {
			if (!isRecord(value) || typeof value.number !== "number") {
				return fail("GitHub answered 200 but one entry is not a sub-issue");
			}
			if (value.state !== "open" && value.state !== "closed") {
				return fail(
					`GitHub answered 200 but sub-issue #${value.number} carries no readable \`state\``,
				);
			}
			links.push({
				number: value.number,
				state: value.state,
				stateReason: typeof value.state_reason === "string" ? value.state_reason : null,
			});
		}
		return ok(links);
	});

/** One child as the ledger reads it — labels, body, and the three-state assignee slot. */
export interface ChildPayload {
	readonly number: number;
	readonly labels: ReadonlyArray<string>;
	readonly body: string;
	readonly state: string;
	/** The observed logins, or `null` when the payload carried no `assignees` key at all. */
	readonly assignees: ReadonlyArray<string> | null;
	readonly assigneesObserved: boolean;
}

const SHAPE = "GitHub answered 200 but its body is not an issue";

const toChildPayload = (value: unknown): Attempt<ChildPayload> => {
	if (!isRecord(value) || typeof value.number !== "number") return fail(SHAPE);
	const names = Array.isArray(value.labels)
		? value.labels.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : null))
		: null;
	if (names === null || names.includes(null)) return fail(SHAPE);

	const observed = Object.hasOwn(value, "assignees") && Array.isArray(value.assignees);
	const logins = observed
		? (value.assignees as ReadonlyArray<unknown>).map((a) =>
				isRecord(a) && typeof a.login === "string" ? a.login : null,
			)
		: null;
	if (logins?.includes(null) === true) return fail(SHAPE);

	return ok({
		number: value.number,
		labels: names as ReadonlyArray<string>,
		body: typeof value.body === "string" ? value.body : "",
		state: typeof value.state === "string" ? value.state : "",
		assignees: logins as ReadonlyArray<string> | null,
		assigneesObserved: observed,
	});
};

export const getChild = (repo: string, child: number, env: Env): Authed<Existence<ChildPayload>> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return unknown<ChildPayload>(token.reason);
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/issues/${child}`);
		return existenceOf(outcome, toChildPayload);
	});

/**
 * Whether the repository carries the cycle doc — three-valued, and the third value is the point.
 *
 * A probe that **failed** answers `unknown`, which puts `MISSING_CONTAINMENT` in the floor's
 * `skipped` array rather than evaluating it false. Folding `unknown` into `absent` is precisely v1's
 * bug: a transient failure silently switched the whole class off for a run.
 */
export const probeCycleDoc = (repo: string, path: string, env: Env): Authed<CycleDoc> =>
	Effect.gen(function* () {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return "unknown" as const;
		const outcome = yield* restRead(token.value, "GET", `repos/${repo}/contents/${path}`);
		if (outcome._tag === "Unreachable") return "unknown" as const;
		if (outcome.status >= 200 && outcome.status < 300) return "present" as const;
		return outcome.status === 404 ? ("absent" as const) : ("unknown" as const);
	});
