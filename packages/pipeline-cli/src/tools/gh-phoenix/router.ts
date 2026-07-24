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
 * `owner/name` the REST rewrites target; `bodyFileExists` reports whether a
 * `--body-file <path>` argument names an existing readable file (the IO is done
 * by the caller and handed in, keeping this core pure).
 */
export const route = (
	argv: ReadonlyArray<string>,
	opts: {readonly repo: string; readonly bodyFileExists?: (path: string) => boolean},
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
	repo: string,
	bodyFileExists: (path: string) => boolean,
): GhRoute => {
	const target = rest.find((a) => /^\d+$/.test(a));
	if (target === undefined) {
		return {
			kind: "block",
			reason: `\`gh ${verb} edit\` without a numeric #N target can't be rewritten to a REST PATCH.`,
			hint: `Pass the issue/PR number, e.g. \`gh api -X PATCH repos/${repo}/${verb === "pr" ? "pulls" : "issues"}/<N> -f ...\`.`,
		};
	}

	// pulls and issues share the issues PATCH surface for body/title/milestone (a PR is an
	// issue in REST); milestone/labels live on the issues resource for both.
	const apiArgv: string[] = ["api", "-X", "PATCH", `repos/${repo}/issues/${target}`];
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
			hint: `Use \`gh api -X PATCH repos/${repo}/issues/${target} -f <field>=<value>\` directly.`,
		};
	}

	return {
		kind: "rewrite",
		argv: apiArgv,
		reason: `\`gh ${verb} edit\` routed to REST PATCH (GraphQL edit path breaks on Projects-classic).`,
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
