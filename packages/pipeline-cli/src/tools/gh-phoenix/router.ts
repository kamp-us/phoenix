/**
 * `gh-phoenix` router core — the pure, IO-free decision over a `gh`
 * argument vector. It is the shim that keeps a reflexive `gh pr edit` / `gh
 * project` from eating a Projects-classic GraphQL error on the kamp-us org
 * (issue #743): those verbs route to REST, classic-projects GraphQL fields are
 * stripped, milestone titles are flagged for resolution, and unsafe `--body-file`
 * paths fast-fail with a hint.
 *
 * The router decides; `bin.ts` executes. `route(argv)` maps a `gh <subcommand>`
 * invocation to one of three outcomes:
 *
 *   - `passthrough`  — a safe REST/porcelain `gh` call; run real `gh` unchanged.
 *   - `rewrite`      — a GraphQL-breaking verb with a known REST equivalent;
 *                      run the rewritten `gh api` REST argv instead.
 *   - `block`        — a GraphQL-breaking verb with no safe rewrite (or an
 *                      invalid invocation, e.g. a missing `--body-file`); fail
 *                      fast with a REST-path hint, never shell the breaking call.
 *
 * Why a deny-list, not an allow-list: only a SMALL set of `gh` paths break on
 * this org (the Projects-classic GraphQL ones — `gh project`, the GraphQL fields
 * `gh pr/issue view` can request, classic-projects fields). Everything else is
 * fine, so the safe default is passthrough; the router only diverts the known
 * breakers. That keeps the shim transparent — a subagent's ordinary `gh api
 * repos/...` REST calls are untouched.
 */

export interface PassthroughRoute {
	readonly kind: "passthrough";
	/** The argv to hand to the real `gh` (unchanged from input). */
	readonly argv: ReadonlyArray<string>;
}

export interface RewriteRoute {
	readonly kind: "rewrite";
	/** The rewritten argv to hand to the real `gh` (a REST `gh api ...` call). */
	readonly argv: ReadonlyArray<string>;
	/** Why the rewrite happened — surfaced on stderr so the rewrite is observable. */
	readonly reason: string;
	/**
	 * Fields/flags stripped from the original invocation because they are
	 * Projects-classic GraphQL surfaces that break on this org. Empty when the
	 * rewrite changed only the transport, not the requested fields.
	 */
	readonly stripped: ReadonlyArray<string>;
}

export interface BlockRoute {
	readonly kind: "block";
	/** Human-readable reason the call was blocked. */
	readonly reason: string;
	/** The REST path / fix a subagent should use instead. */
	readonly hint: string;
}

export type GhRoute = PassthroughRoute | RewriteRoute | BlockRoute;

/**
 * Classic-projects + GraphQL-only field tokens that break on this org. A `gh
 * pr/issue view --json <field>` naming one of these triggers a strip (the field
 * is dropped from the REST projection) or, when the field IS the whole point of
 * the call, a block with a REST hint. `closingIssuesReferences` is the canonical
 * one (#743) — a GraphQL-only connection with no REST projection.
 */
const GRAPHQL_BREAKING_FIELDS = new Set([
	"closingIssuesReferences",
	"projectCards",
	"projectItems",
	"projects",
	"projectsV2",
]);

/** Read the value of `--flag value` or `--flag=value` from an argv slice. */
const readFlag = (argv: ReadonlyArray<string>, flag: string): string | null => {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === flag) return argv[i + 1] ?? null;
		if (a !== undefined && a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
	}
	return null;
};

/** A well-formed `owner/name` slug — the shape every REST rewrite path is built from. */
export const isRepoSlug = (value: string): boolean => /^[^/\s]+\/[^/\s]+$/.test(value.trim());

/**
 * What the caller said about the target repository with `-R` / `--repo`. The three cases are
 * distinguished because an unusable value must NOT degrade to the resolved repo: silently
 * substituting a repository the caller did not name is the defect (#4301, #4270).
 */
type RepoFlag =
	| {readonly kind: "absent"}
	| {readonly kind: "named"; readonly flag: string; readonly repo: string}
	| {readonly kind: "unusable"; readonly flag: string; readonly raw: string | null};

/**
 * Read `-R` / `--repo` off an argv slice, in every form real `gh` accepts: `--repo value`,
 * `--repo=value`, `-R value`, `-R=value`, and the attached shorthand `-Rowner/name`. The
 * attached form is covered on purpose — leaving one spelling unparsed would leave one
 * spelling silently retargeted, which is the whole defect.
 */
const readRepoFlag = (argv: ReadonlyArray<string>): RepoFlag => {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		let flag: string | null = null;
		let raw: string | null = null;
		if (a === "-R" || a === "--repo") {
			flag = a;
			raw = argv[i + 1] ?? null;
		} else if (a.startsWith("--repo=")) {
			flag = "--repo";
			raw = a.slice("--repo=".length);
		} else if (a.startsWith("-R")) {
			flag = "-R";
			const attached = a.slice("-R".length);
			raw = attached.startsWith("=") ? attached.slice(1) : attached;
		}
		if (flag === null) continue;
		if (raw !== null && isRepoSlug(raw)) return {kind: "named", flag, repo: raw.trim()};
		return {kind: "unusable", flag, raw};
	}
	return {kind: "absent"};
};

/**
 * Long flags on `gh <pr|issue> edit` that are booleans — they carry no value, so a positional
 * scan must NOT swallow the token after them. Every other `--flag` is assumed to take a value:
 * over-skipping ends in a refusal (no positional found → block), while under-skipping revives
 * the defect the positional scan exists to remove — a flag's value posing as the target (#4339).
 */
const BOOLEAN_EDIT_FLAGS = new Set(["--help", "-h"]);

/**
 * Locate the positional `<N>` of `gh <pr|issue> edit` BY POSITION — walking left to right and
 * skipping each flag together with its value — never by scanning for the first bare integer.
 * The content scan let a flag value steal the target: `gh pr edit --milestone 3 5` PATCHed
 * issue 3, silently and successfully, because `3` came first (#4339). Returns the first
 * non-flag token, or `undefined` when the invocation carries none; the caller still requires
 * it to be numeric, so an ambiguous argv refuses rather than guesses.
 */
const findPositionalTarget = (rest: ReadonlyArray<string>): string | undefined => {
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === undefined) continue;
		if (a === "--") return rest[i + 1]; // the end-of-flags separator: the rest is positional
		if (a.startsWith("--")) {
			if (a.includes("=")) continue; // `--flag=value` carries its own value
			if (BOOLEAN_EDIT_FLAGS.has(a)) continue;
			i++; // `--flag value`
			continue;
		}
		if (a.startsWith("-") && a.length > 1) {
			if (a.length > 2) continue; // attached shorthand value, e.g. `-Rowner/name`, `-m3`
			if (BOOLEAN_EDIT_FLAGS.has(a)) continue;
			i++;
			continue;
		}
		return a;
	}
	return undefined;
};

/** Split a comma-separated `--json` field list, trimming blanks. */
const splitFields = (raw: string): ReadonlyArray<string> =>
	raw
		.split(",")
		.map((f) => f.trim())
		.filter((f) => f.length > 0);

/**
 * Is `value` a milestone TITLE rather than a number? `gh issue edit --milestone`
 * accepts a title, but the REST `PATCH .../issues/N` needs the milestone NUMBER,
 * so a title must be resolved first. A bare integer is already a number; anything
 * else is a title needing resolution.
 */
export const isMilestoneTitle = (value: string): boolean => !/^\d+$/.test(value.trim());

/**
 * The pure routing decision over a `gh` argv (the vector AFTER the `gh` binary
 * name — i.e. `process.argv.slice(2)` for the shim). `repo` is the resolved
 * `owner/name` the REST rewrites target, or `null` when resolution failed — only the
 * rewrite paths that must name a repo refuse on `null`, so an unresolved repo never
 * costs a passthrough that needs none. `bodyFileExists` reports whether a
 * `--body-file <path>` argument names an existing readable file (the IO is done
 * by the caller and handed in, keeping this core pure).
 */
export const route = (
	argv: ReadonlyArray<string>,
	opts: {readonly repo: string | null; readonly bodyFileExists?: (path: string) => boolean},
): GhRoute => {
	const bodyFileExists = opts.bodyFileExists ?? (() => true);
	const [verb, sub, ...rest] = argv;

	// `gh project ...` — the whole noun is Projects (classic-or-v2) GraphQL; there is
	// no transparent REST rewrite for it on this org. Block with a hint.
	if (verb === "project") {
		return {
			kind: "block",
			reason: "`gh project` is GraphQL-backed and breaks on the kamp-us Projects-classic org.",
			hint: "Use the REST issues/labels API instead (`gh api repos/<owner>/<repo>/issues/...`); classic Projects has no supported REST surface here.",
		};
	}

	// `gh pr edit` / `gh issue edit` — porcelain that hits the GraphQL mutation path on
	// this org. Rewrite the safe, common edits (body, title, milestone) to REST PATCH.
	if ((verb === "pr" || verb === "issue") && sub === "edit") {
		return routeEdit(verb, rest, opts.repo, bodyFileExists);
	}

	// `gh pr view` / `gh issue view --json <fields>` — strip GraphQL-only fields from the
	// projection so the REST-backed `--json` view doesn't request a breaking connection.
	if ((verb === "pr" || verb === "issue") && sub === "view") {
		return routeView(argv, rest);
	}

	// Everything else (incl. `gh api ...` REST, `gh pr create`, `gh pr list`) is safe.
	return {kind: "passthrough", argv};
};

/** Map `gh <pr|issue> edit <N> [flags]` to a REST `gh api -X PATCH ...` call. */
const routeEdit = (
	verb: string,
	rest: ReadonlyArray<string>,
	repo: string | null,
	bodyFileExists: (path: string) => boolean,
): GhRoute => {
	// An explicit `-R`/`--repo` IS the target: this rewrite synthesizes a fresh argv, so a flag
	// it does not read is a flag it drops — and the PATCH then lands on the resolved repo the
	// caller never named (#4301). Honoring it also means an unusable value refuses rather than
	// falling back, and a `-R` supplies a target even when resolution found none.
	const flagged = readRepoFlag(rest);
	if (flagged.kind === "unusable") {
		return {
			kind: "block",
			reason: `\`gh ${verb} edit\` was given \`${flagged.flag}${flagged.raw === null ? "" : ` ${flagged.raw}`}\`, which is not an \`owner/name\` repository.`,
			hint: `Pass \`${flagged.flag} <owner>/<name>\`. Refusing rather than PATCHing the repository this shim resolved, which you did not name.`,
		};
	}
	const targetRepo = flagged.kind === "named" ? flagged.repo : repo;

	// The rewrite target is `repos/<repo>/issues/<N>`, so an unresolved repo has no honest
	// value to substitute — refuse. Defaulting to any slug aims the PATCH at a repository
	// the caller never named (#4270).
	if (targetRepo === null) {
		return {
			kind: "block",
			reason: `\`gh ${verb} edit\` needs a target repository and none resolved — $CLAUDE_PIPELINE_REPO and $GITHUB_REPOSITORY are unset (or malformed) and \`gh repo view\` did not answer.`,
			hint: "Set CLAUDE_PIPELINE_REPO=<owner>/<name>, or run inside a git repo whose origin `gh repo view` can read. Refusing rather than PATCHing a repository you did not name.",
		};
	}

	const target = findPositionalTarget(rest);
	if (target === undefined || /^\d+$/.test(target) === false) {
		return {
			kind: "block",
			reason: `\`gh ${verb} edit\` without a numeric #N target can't be rewritten to a REST PATCH.`,
			hint: `Pass the issue/PR number, e.g. \`gh api -X PATCH repos/${targetRepo}/${verb === "pr" ? "pulls" : "issues"}/<N> -f ...\`.`,
		};
	}

	// pulls and issues share the issues PATCH surface for body/title/milestone (a PR is an
	// issue in REST); milestone/labels live on the issues resource for both.
	const apiArgv: string[] = ["api", "-X", "PATCH", `repos/${targetRepo}/issues/${target}`];
	const stripped: string[] = [];

	const bodyFile = readFlag(rest, "--body-file");
	if (bodyFile !== null) {
		if (!bodyFileExists(bodyFile)) {
			return {
				kind: "block",
				reason: `--body-file path does not exist: ${bodyFile}`,
				hint: "Write the body file first (or pass --body inline); never PATCH from a missing file.",
			};
		}
		apiArgv.push("-F", `body=@${bodyFile}`);
	}

	const body = readFlag(rest, "--body");
	if (body !== null) apiArgv.push("-f", `body=${body}`);

	const title = readFlag(rest, "--title");
	if (title !== null) apiArgv.push("-f", `title=${title}`);

	const milestone = readFlag(rest, "--milestone");
	if (milestone !== null) {
		if (isMilestoneTitle(milestone)) {
			// A title must be resolved to its number before the REST PATCH — the caller does the
			// lookup (GET .../milestones) and substitutes; the router flags the need via `stripped`
			// so the bin layer knows to resolve rather than pass the raw title.
			stripped.push(`milestone-title:${milestone}`);
		} else {
			apiArgv.push("-F", `milestone=${milestone.trim()}`);
		}
	}

	// Strip add/remove-project flags entirely — classic Projects GraphQL, no REST PATCH field.
	for (const flag of ["--add-project", "--remove-project"]) {
		const v = readFlag(rest, flag);
		if (v !== null) stripped.push(`${flag} ${v}`);
	}

	if (apiArgv.length === 4 && stripped.length === 0) {
		// Nothing rewritable and nothing stripped → there was no edit we understand. Block
		// rather than silently PATCH an empty body.
		return {
			kind: "block",
			reason: `\`gh ${verb} edit\` carried no rewritable field (body/title/milestone).`,
			hint: `Use \`gh api -X PATCH repos/${targetRepo}/issues/${target} -f <field>=<value>\` directly.`,
		};
	}

	return {
		kind: "rewrite",
		argv: apiArgv,
		reason:
			`\`gh ${verb} edit\` routed to REST PATCH (GraphQL edit path breaks on Projects-classic)` +
			(flagged.kind === "named" ? `, targeting \`${flagged.flag} ${targetRepo}\`` : "") +
			".",
		stripped,
	};
};

/** Strip GraphQL-only fields from a `gh <pr|issue> view --json <fields>` projection. */
const routeView = (argv: ReadonlyArray<string>, rest: ReadonlyArray<string>): GhRoute => {
	const jsonRaw = readFlag(rest, "--json");
	if (jsonRaw === null) return {kind: "passthrough", argv};

	const requested = splitFields(jsonRaw);
	const breaking = requested.filter((f) => GRAPHQL_BREAKING_FIELDS.has(f));
	if (breaking.length === 0) return {kind: "passthrough", argv};

	const safe = requested.filter((f) => !GRAPHQL_BREAKING_FIELDS.has(f));
	if (safe.length === 0) {
		// The ENTIRE projection was GraphQL-breaking fields — there's nothing safe left to
		// request, so this view exists only to read a classic-projects surface. Block.
		return {
			kind: "block",
			reason: `\`--json ${jsonRaw}\` requests only GraphQL-breaking field(s): ${breaking.join(", ")}.`,
			hint: "These are Projects-classic/GraphQL-only fields with no REST projection on this org — drop them.",
		};
	}

	// Rebuild the argv with the breaking fields stripped from --json. The transport is
	// unchanged (gh's --json view IS REST-backed once the GraphQL-only fields are gone).
	const rebuilt: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") {
			rebuilt.push("--json", safe.join(","));
			i++; // skip the original value
			continue;
		}
		if (a !== undefined && a.startsWith("--json=")) {
			rebuilt.push(`--json=${safe.join(",")}`);
			continue;
		}
		if (a !== undefined) rebuilt.push(a);
	}

	return {
		kind: "rewrite",
		argv: rebuilt,
		reason:
			"Stripped GraphQL-only field(s) from a `view --json` projection (break on Projects-classic).",
		stripped: breaking,
	};
};
