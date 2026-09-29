/**
 * The trunk: the branch a standalone lane is cut from, a PR merges into, and a plan is judged fresh
 * against. Every verb that means "the trunk" asks {@link resolveTrunk}, and nothing spells a branch
 * name for it.
 *
 * The source of truth is GitHub's `default_branch`, because that is the branch a PR merges into. A
 * repo whose default branch is `dev` and that has no `main` at all is an ordinary adopter, so a read
 * that fails is a failure carrying {@link TRUNK_FIX}, never a fall back to a spelling.
 *
 * This clone's `origin/HEAD` is not the trunk. It is git's local note of the remote's default
 * branch, recorded at clone time and never refreshed by a fetch. {@link readOriginHead} reads it
 * only so `status open` can say when it has drifted from the trunk.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10030
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {execCapture, execExit} from "./exec.ts";
import {type Api, onTransport, refusalText, resolveToken, restRead} from "./gh-api.ts";
import {type Attempt, fail, ok, type Shell} from "./git.ts";
import {resolveRepo} from "./issues.ts";
import {isRecord} from "./json.ts";

/** The remote every trunk ref is read from. */
export const TRUNK_REMOTE = "origin";

export interface Trunk {
	/** The bare branch name, as a PR's base names it: `dev`. */
	readonly branch: string;
	/** Its remote-tracking ref, as git reads it after a fetch: `origin/dev`. */
	readonly ref: string;
}

export const trunkNamed = (branch: string): Trunk => ({branch, ref: `${TRUNK_REMOTE}/${branch}`});

/** What an operator does when the trunk cannot be read. Every refusal over one quotes it. */
export const TRUNK_FIX =
	"the trunk is GitHub's default branch, so set GITHUB_TOKEN or GH_TOKEN (or run `gh auth login`) and make sure the repo resolves through --repo, $CLAUDE_PIPELINE_REPO or the origin remote; no verb falls back to main";

/** `<what failed>: <why> — <fix>`, the one sentence every trunk refusal carries. */
export const trunkUnresolved = (reason: string): string =>
	`cannot resolve the trunk: ${reason} — ${TRUNK_FIX}`;

/**
 * Trunks already read, per transport. `src/run.ts` provides one `HttpClient` per process, so this is
 * a per-process memo there, while each test's fake transport starts cold with no reset hook to call.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10123
 */
const knownTrunks = new WeakMap<HttpClient.HttpClient, Map<string, Trunk>>();

/**
 * GitHub's default branch for `repo`, on a credential the caller already holds, read at most once per
 * repo per transport. A failed read is not memoised: it is a transient answer, and the next caller
 * asks again.
 */
export const readTrunk = (token: string, repo: string): Api<Attempt<Trunk>> =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const known = knownTrunks.get(client) ?? new Map<string, Trunk>();
		knownTrunks.set(client, known);
		const cached = known.get(repo);
		if (cached !== undefined) return ok(cached);

		const outcome = yield* restRead(token, "GET", `repos/${repo}`);
		if (outcome._tag === "Unreachable") return fail(outcome.reason);
		if (outcome.status < 200 || outcome.status >= 300) return fail(refusalText(outcome));
		const name = isRecord(outcome.body) ? outcome.body.default_branch : undefined;
		if (typeof name !== "string" || name.trim() === "") {
			return fail(`GitHub answered 200 for ${repo} but named no default branch`);
		}
		const trunk = trunkNamed(name.trim());
		known.set(repo, trunk);
		return ok(trunk);
	});

/**
 * The trunk of `repo`, or of the repo `env` resolves to when `repo` is `null`.
 *
 * The credential comes from `env` the way every other read resolves it, and the transport is the
 * caller's `HttpClient` when one is provided, so a test's scripted client is what answers.
 */
export const resolveTrunk = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string | null,
): Shell<Attempt<Trunk>> =>
	Effect.gen(function* () {
		const target = yield* resolveRepo(repo, env);
		if (target._tag === "Failure") return fail(`the target repo is unresolvable: ${target.reason}`);
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return token;
		return yield* onTransport(readTrunk(token.value, target.value));
	});

/**
 * The ref a `--base` flag reads at: the one the operator named, else the trunk's remote ref.
 *
 * A named base is honoured verbatim, with no trunk read, so a verb run offline or against a fixture
 * remote still works when the operator says where to read.
 */
export const baseOrTrunk = (
	named: string | null,
	env: Readonly<Record<string, string | undefined>>,
	repo: string | null,
): Shell<Attempt<string>> =>
	named !== null
		? Effect.succeed(ok(named))
		: Effect.map(resolveTrunk(env, repo), (trunk) =>
				trunk._tag === "Failure" ? trunk : ok(trunk.value.ref),
			);

/** How a `--base` flag's help names its default. */
export const TRUNK_DEFAULT_HELP = "the trunk, origin/<the repo's GitHub default branch>";

const ORIGIN_HEAD = `refs/remotes/${TRUNK_REMOTE}/HEAD`;

/**
 * The branch this clone's `origin/HEAD` names, or `null` only when git proves it records none.
 *
 * `git symbolic-ref --quiet` exits 1 both when the ref is absent and when it holds a bare commit, so
 * a `for-each-ref` listing splits those two. Every other exit — not a repository, a corrupt ref — and
 * a `git` that cannot start are failures: a read that did not happen proves nothing is recorded.
 */
export const readOriginHead: Shell<Attempt<string | null>> = Effect.gen(function* () {
	const named = yield* execExit("git", ["symbolic-ref", "--quiet", "--short", ORIGIN_HEAD]);
	if (named._tag === "Unstartable") return fail(named.reason);
	if (named.code === 0) {
		const ref = named.stdout.trim();
		const prefix = `${TRUNK_REMOTE}/`;
		return ref.startsWith(prefix) && ref.length > prefix.length
			? ok(ref.slice(prefix.length))
			: fail(`\`git symbolic-ref\` named "${ref}", which is not an ${prefix}<branch> ref`);
	}
	if (named.code !== 1) return fail(named.reason);
	const listed = yield* execCapture("git", ["for-each-ref", "--format=%(refname)", ORIGIN_HEAD]);
	if (!listed.ok) return fail(listed.reason);
	return listed.stdout.trim() === ""
		? ok(null)
		: fail(`${ORIGIN_HEAD} holds a commit, not the name of a branch`);
});

/** How this clone's `origin/HEAD` stands against the trunk. */
export type OriginHeadAgreement =
	| {readonly _tag: "Agrees"}
	| {readonly _tag: "Unset"}
	| {readonly _tag: "Disagrees"; readonly originHead: string};

export const originHeadAgreement = (
	trunk: Trunk,
	originHead: string | null,
): OriginHeadAgreement =>
	originHead === null
		? {_tag: "Unset"}
		: originHead === trunk.branch
			? {_tag: "Agrees"}
			: {_tag: "Disagrees", originHead};

/** The command that re-points `origin/HEAD` at whatever the remote now calls its default branch. */
export const SET_HEAD_FIX = `git remote set-head ${TRUNK_REMOTE} --auto`;
