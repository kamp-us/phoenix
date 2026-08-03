/**
 * Resolve `fabrika <token> …` against the command tree before the Effect CLI runner sees it, so an
 * unresolvable path is refused instead of answered (#4822).
 *
 * The runner cannot do this itself. `Command.runWith` processes **action flags** (step 5) before it
 * inspects accumulated **parse errors** (step 6), and `--help` is an action flag — so a `--help`
 * anywhere in argv runs the help action and returns, discarding the `UnknownSubcommand` error the
 * parser already put in `parsedArgs.errors`. Verified in the installed dependency,
 * `effect@4.0.0-beta.92`, `src/unstable/cli/Command.ts`: line 2327 `// 5. Process action flags —
 * first present action wins, then exit`, line 2341 `// 6. Handle parsing errors`. Without `--help`
 * step 6 raises `ShowHelp` carrying the errors and the process exits 1; with it, exit 0 and the
 * deepest valid prefix's help — at any depth, discarding any number of invalid tail tokens.
 *
 * That matters because `--help` is fabrika's designated discovery probe
 * (`claude-plugins/fabrika/docs/cli-interface-convention.md` §1): the one probe meant to answer
 * "does this path exist?" answered yes for paths that do not.
 *
 * The guard runs on every invocation, not only ones carrying `--help`, so one refusal shape covers
 * both — and it seats that refusal the way §2/§3 of the convention require: the reason on stderr,
 * nothing on stdout, a non-zero exit.
 */

/**
 * The shape this module needs of a command — satisfied by `effect/unstable/cli`'s `Command`, so the
 * guard walks the *same object* the runner parses and cannot drift from the registry.
 */
export interface CommandNode {
	readonly name: string;
	readonly alias: string | undefined;
	readonly hidden: boolean;
	readonly subcommands: ReadonlyArray<{readonly commands: ReadonlyArray<CommandNode>}>;
}

/** A token that named no subcommand of the node it sat under. */
export interface UnknownSubcommand {
	/** The offending token. */
	readonly token: string;
	/** The command path it sat under, root first — e.g. `["fabrika", "adr"]`. */
	readonly path: ReadonlyArray<string>;
	/** What that node does accept, in declaration order. */
	readonly known: ReadonlyArray<string>;
}

/**
 * Name → subcommand, plus each alias, mirroring the parser's own `buildSubcommandIndex`
 * (`effect/unstable/cli/internal/parser.ts`). Hidden subcommands are indexed: the parser resolves
 * them by exact name too, and only excludes them from what it *offers*.
 */
const subcommandIndex = (node: CommandNode): ReadonlyMap<string, CommandNode> => {
	const index = new Map<string, CommandNode>();
	for (const group of node.subcommands) {
		for (const sub of group.commands) {
			index.set(sub.name, sub);
			if (sub.alias !== undefined && sub.alias !== sub.name) index.set(sub.alias, sub);
		}
	}
	return index;
};

/** What a node offers: hidden subcommands are withheld so a typo cannot reveal one (same parser). */
const offered = (node: CommandNode): ReadonlyArray<string> =>
	node.subcommands.flatMap((group) =>
		group.commands.filter((sub) => !sub.hidden).map((sub) => sub.name),
	);

/**
 * Walk `argv` down the tree and return the first token that names no subcommand of the node it sits
 * under, or `undefined` when the path resolves.
 *
 * Two stopping rules, both of which can only *miss* an unknown path and never invent one — the
 * fail-safe direction for a guard whose output is a refusal:
 *
 * - **A leaf ends the walk.** A node with no subcommands takes arguments, so its tokens are its own.
 * - **A flag ends the walk.** A later bare token may be that flag's value (`--log-level debug`), and
 *   reading a flag value as a subcommand would refuse a valid invocation.
 *
 * One divergence from the parser: it suppresses `UnknownSubcommand` when the node *also* declares
 * positional arguments (`resolveFirstValue`'s `expectsArgs` branch), which the public `Command`
 * surface does not expose. No fabrika node has both — every node carrying subcommands is a bare
 * `Command.make(name)` router — and `unknown-subcommand.unit.test.ts` re-proves that against the
 * real tree by running the parser itself at each such node.
 */
export const findUnknownSubcommand = (
	root: CommandNode,
	argv: ReadonlyArray<string>,
): UnknownSubcommand | undefined => {
	let node = root;
	const path: Array<string> = [root.name];
	for (const token of argv) {
		if (token.startsWith("-")) return undefined;
		const index = subcommandIndex(node);
		if (index.size === 0) return undefined;
		const next = index.get(token);
		if (next === undefined) return {token, path: [...path], known: offered(node)};
		node = next;
		path.push(next.name);
	}
	return undefined;
};

/**
 * The stderr line for a refusal.
 *
 * It keeps the runner's own `Unknown subcommand "x" for "y"` wording — that phrasing is what callers
 * already match on — and appends what the node does accept, which is more use to a caller than the
 * help body this refusal replaces on stdout.
 */
export const refusal = (unknown: UnknownSubcommand): string =>
	`fabrika: Unknown subcommand "${unknown.token}" for "${unknown.path.join(" ")}" — known subcommands: ${
		unknown.known.join(", ") || "(none)"
	}`;
