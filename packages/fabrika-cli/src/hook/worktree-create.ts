/**
 * The decisions behind `hook worktree-create`, with no subprocess and no fd in sight.
 *
 * `WorktreeCreate` is a **provider** hook: the harness hands it a slug and expects the worktree to
 * exist and its path on stdout when the hook exits 0 (`../../../../claude-plugins/fabrika/docs/hook-surface.md`).
 * So the verb beside this file runs two git commands, and everything it has to get *right* before it
 * runs them — where the tree goes, what the child's `PATH` must carry — is decided here, where a
 * unit test can drive it.
 *
 * Two facts this module encodes are captured, not assumed (ADR 0180): the payload carries `cwd` and
 * `name` and **no** `worktree_path` or `base_ref`, and the path is therefore *constructed* rather
 * than read. `__fixtures__/worktree-create.payload.golden.json` is the capture.
 */

/** Where a hook-provisioned worktree goes, and the repo the git commands run in. */
export interface WorktreePlan {
	/** The repository root the payload named. Every git command runs here, not in `process.cwd()`. */
	readonly repoRoot: string;
	/** The harness's suggested slug, verbatim. */
	readonly name: string;
	/** `<repoRoot>/.claude/worktrees/<name>` — the layout the harness's own default path uses. */
	readonly worktreePath: string;
}

export type PlanRead =
	| {readonly _tag: "Plan"; readonly plan: WorktreePlan}
	| {readonly _tag: "Unplannable"; readonly reason: string};

/**
 * A slug that cannot escape `<repoRoot>/.claude/worktrees/`.
 *
 * The harness validates the path it gets *back* — it rejects dot segments — but a hook that built a
 * traversing path has already run `git worktree add` at it by then, so the refusal must happen
 * before the mutation, not after.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The one place the worktree path is composed. Both the verb and its test read it from here. */
export const worktreePathFor = (repoRoot: string, name: string): string =>
	`${repoRoot}/.claude/worktrees/${name}`;

/**
 * Where this spawn's fetched base lands — a ref **no sibling spawn can write**.
 *
 * `FETCH_HEAD` is one file in the shared `.git` dir and every parallel spawn fetches against the same
 * clone, so one spawn reads it while a sibling's fetch has it truncated and the read returns nothing.
 * Measured on git 2.40.1 in this repo's `worktree-base.git.test.ts` fixture: 12 of 320 concurrent
 * fetch-then-resolve pairs lost the base that way (#6081). Serializing the pair would fix it too, but
 * a per-spawn name removes the shared write instead of taking turns at it.
 *
 * The slug is folded to `[A-Za-z0-9-]` so it cannot carry a `..` or a `.lock` suffix into a refname,
 * and the nonce — not the slug — is what makes the name unique: two slugs that differ only in
 * punctuation fold together, which would put the shared write straight back.
 */
export const baseRefFor = (name: string, nonce: string): string =>
	`refs/fabrika/worktree-base/${name.replace(/[^A-Za-z0-9]+/g, "-")}-${nonce}`;

/** The fully-qualified source is deliberate: an unqualified `main` also matches a tag named `main`. */
export const fetchBaseArgs = (base: string, baseRef: string): ReadonlyArray<string> => [
	"fetch",
	"--quiet",
	"origin",
	`+refs/heads/${base}:${baseRef}`,
];

export const resolveBaseArgs = (baseRef: string): ReadonlyArray<string> => [
	"rev-parse",
	"--verify",
	"--quiet",
	`${baseRef}^{commit}`,
];

export const dropBaseRefArgs = (baseRef: string): ReadonlyArray<string> => [
	"update-ref",
	"-d",
	baseRef,
];

/** 40 hex for sha1, 64 for sha256 — anything else is not an object id this verb may branch from. */
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const isCommitId = (candidate: string): boolean => COMMIT_ID.test(candidate);

/**
 * Turn a captured `WorktreeCreate` payload into the plan, or say why there is none.
 *
 * Every arm is fail-closed on purpose: the verb's caller is the harness, a refusal there blocks the
 * spawn, and a spawn that never happens is strictly better than one landing in a tree this hook
 * could not fully build (ADR 0092).
 */
export const planWorktree = (payload: Record<string, unknown>): PlanRead => {
	const repoRoot = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
	const name = typeof payload.name === "string" ? payload.name.trim() : "";

	if (repoRoot === "") return {_tag: "Unplannable", reason: "the payload carries no `cwd`"};
	if (!repoRoot.startsWith("/")) {
		return {_tag: "Unplannable", reason: `\`cwd\` is not an absolute path: ${repoRoot}`};
	}
	if (name === "") return {_tag: "Unplannable", reason: "the payload carries no `name`"};
	if (!SAFE_NAME.test(name)) {
		return {
			_tag: "Unplannable",
			reason: `\`name\` is not a plain worktree slug and could escape the worktree root: ${name}`,
		};
	}

	return {_tag: "Plan", plan: {repoRoot, name, worktreePath: worktreePathFor(repoRoot, name)}};
};

/**
 * The standard toolchain locations, prepended to whatever `PATH` the hook inherited.
 *
 * This is the whole reason provisioning works at all. `git worktree add` fires lefthook's
 * `post-checkout` `bootstrap-deps`, and that hook **clean-SKIPs at exit 0** when it finds no
 * corepack, no pinned pnpm and no npm on `PATH` (ADR 0109 §3) — which is precisely the harness's
 * PATH-stripped `git worktree add` exec env (#787–#789). A skip there is silent, so the tree is
 * created, adopted, and useless. Prepending the OS-standard bin dirs is what lets the install run.
 *
 * OS/standard dirs only, never a per-machine volta/fnm shim — ADR 0109's prohibition. The inherited
 * `PATH` is kept **last** rather than dropped, so a machine whose toolchain lives somewhere else
 * still resolves it.
 */
const STANDARD_BIN_DIRS: ReadonlyArray<string> = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/bin",
	"/usr/bin",
];

export const toolchainPath = (inherited: string | undefined, home: string | undefined): string => {
	const localBin = home === undefined || home.trim() === "" ? [] : [`${home}/.local/bin`];
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const dir of [
		...STANDARD_BIN_DIRS,
		...localBin,
		...(inherited ?? "").split(":").filter((d) => d !== ""),
	]) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		ordered.push(dir);
	}
	return ordered.join(":");
};

/** What `bootstrap-deps` needs: the pnpm/corepack store under `HOME`, and a stable locale. */
const INSTALL_KEYS: ReadonlyArray<string> = [
	"HOME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"COREPACK_HOME",
	"XDG_CACHE_HOME",
];

/**
 * What `git fetch origin` needs. phoenix's `origin` is SSH-only — `url.git@github.com:.insteadof`
 * rewrites every HTTPS remote — so with no agent socket the fetch has no credential path at all.
 */
const CREDENTIAL_KEYS: ReadonlyArray<string> = [
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
];

/**
 * The ssh command, forced non-interactive.
 *
 * A hook child has no tty and inherits no `SSH_ASKPASS`/`DISPLAY`, so an ssh that decides to ask for
 * a passphrase cannot be answered — it just blocks until the 540s child timeout, turning every spawn
 * into a nine-minute refusal. `BatchMode=yes` makes that same miss fail at once.
 */
const nonInteractiveSsh = (inherited: string | undefined): string => {
	const command = inherited === undefined || inherited.trim() === "" ? "ssh" : inherited.trim();
	return /batchmode/i.test(command) ? command : `${command} -o BatchMode=yes`;
};

/**
 * The environment the two git children run under.
 *
 * Nothing is inherited implicitly (`execRecord` sets `extendEnv: false`), so what is not here does
 * not reach the children. Two jobs are served: the install's store and locale, and the fetch's
 * credentials — which are forwarded *and* pinned non-interactive, so a credential miss refuses at
 * `BASE_FETCH_FAILED` in seconds rather than hanging out the child timeout (ADR 0337).
 */
export const childEnv = (
	source: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
	const env: Record<string, string> = {PATH: toolchainPath(source.PATH, source.HOME)};
	for (const key of [...INSTALL_KEYS, ...CREDENTIAL_KEYS]) {
		const value = source[key];
		if (value !== undefined && value !== "") env[key] = value;
	}

	env.GIT_TERMINAL_PROMPT = "0";
	// An operator's `GIT_SSH` wrapper is the transport git would pick; injecting a `GIT_SSH_COMMAND`
	// beside it would silently outrank it, so that one case is left exactly as it was inherited.
	if (env.GIT_SSH === undefined || env.GIT_SSH_COMMAND !== undefined) {
		env.GIT_SSH_COMMAND = nonInteractiveSsh(env.GIT_SSH_COMMAND);
	}
	return env;
};
