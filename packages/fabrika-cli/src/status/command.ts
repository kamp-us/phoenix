/**
 * The `status` verb group — `fabrika status <verb>`.
 *
 * The adapter and nothing else: it declares the flags, reads the world, runs the pure verb, and
 * emits its outcome. Every decision lives in the `*-verb.ts` modules beside it, which is what makes
 * each refusal testable without spawning a process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form
 * silently opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */
import {homedir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {Effect, type FileSystem, Option, type Path} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {CONFIG_PATH, type ConfigSource} from "../config/document.ts";
import {readConfigSource} from "../config/source.ts";
import {repoConfigSource} from "../config/working-root.ts";
import {discoverRepoRoot} from "../delegate/root.ts";
import {leafCommand} from "../excess-operand.ts";
import type {Attempt} from "../io/git.ts";
import {resolveRepo} from "../io/issues.ts";
import {readStdin} from "../io/stdin.ts";
import {DEFAULT_STALE_MINUTES} from "../lane/stale.ts";
import {runStale} from "../lane/stale-verb.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT} from "../lane/store.ts";
import type {VerbOutcome} from "../verb.ts";
import {readBoard, runBoard} from "./board-verb.ts";
import {knownIds, runBootstrap} from "./bootstrap-verb.ts";
import {instant, readNow} from "./fields.ts";
import {runMenu} from "./menu-verb.ts";
import {
	badFieldRefusal,
	boardField,
	FIELDS,
	type Field,
	isFieldName,
	lanesField,
	menuField,
	readoutField,
	runOpen,
	settingsField,
	wiringField,
} from "./open-verb.ts";
import {badIssueRefusal, issueNumberOf, readReadout, runReadout} from "./readout-verb.ts";
import {type RosterSources, readRoster} from "./roster.ts";
import {runSettings, settingRows} from "./settings-verb.ts";
import {readWiringSource, repoWiringSource, runWiring, wiringOf} from "./wiring-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const skillsDirFlag = Flag.string("skills-dir").pipe(
	Flag.optional,
	Flag.withDescription(
		"the roster root to read (default: $CLAUDE_PLUGIN_ROOT's skills tree, else a plugin the CLI runs from inside of, else claude-plugins/fabrika/skills beneath the repo root, else the same path beneath the checkout the CLI itself runs from, else the installed fabrika plugin under Claude Code's plugin cache, which is plugins/cache beneath $CLAUDE_CONFIG_DIR, or beneath .claude in the home directory when $CLAUDE_CONFIG_DIR is unset or empty)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

/**
 * Claude Code's plugin cache, honouring `$CLAUDE_CONFIG_DIR` — the harness's own override for where
 * `~/.claude` lives, so a relocated config directory resolves its cache rather than the home one.
 */
const pluginCacheRoot = (): string | null => {
	const configured = process.env.CLAUDE_CONFIG_DIR;
	// An empty value reads as unset, not as the relative path `plugins/cache` a bare join would
	// produce — a rung rooted at the cwd would answer about a directory nobody configured.
	const root = configured === undefined || configured === "" ? null : configured;
	const home = homedir();
	if (root === null && home === "") return null;
	return join(root ?? join(home, ".claude"), "plugins", "cache");
};

/** The roster sources this invocation resolves against — the world the ladder reads. */
const rosterSources = (explicit: string | null): RosterSources => ({
	explicit,
	pluginRootEnv: process.env.CLAUDE_PLUGIN_ROOT ?? null,
	pluginCache: pluginCacheRoot(),
	moduleDir: fileURLToPath(new URL(".", import.meta.url)),
	cwd: process.cwd(),
});

/**
 * The repository root a declared path is probed against, falling back to the cwd.
 *
 * The fallback is safe for **path probes and nothing else**: a probe rooted at the cwd answers about
 * *some* real directory, and every row it produces says which path it looked at, so nothing is
 * reported present that was not found. It does not extend to reading config, because "no file at a
 * root nobody located" would resolve as "this repo declared nothing" — which is why anything that
 * writes off the config takes `repoConfigSource` instead, where a failed discovery is `Unreadable`.
 */
const repositoryRoot: Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> = Effect.gen(
	function* () {
		const found = yield* Effect.result(discoverRepoRoot(process.cwd()));
		return found._tag === "Success" ? (found.success ?? process.cwd()) : process.cwd();
	},
);

/** The config surface under `root` when one was declared, else the one above the cwd. */
const configSurface = (
	root: string | null,
): Effect.Effect<ConfigSource, never, FileSystem.FileSystem | Path.Path> =>
	root === null ? repoConfigSource(process.cwd()) : readConfigSource(root);

const resolveTarget = (explicit: string | null) => resolveRepo(explicit, process.env);

const menu = leafCommand(
	"menu",
	{skillsDir: skillsDirFlag, json: jsonFlag},
	Effect.fn(function* ({skillsDir, json}) {
		const roster = yield* readRoster(rosterSources(Option.getOrNull(skillsDir)));
		yield* emit(runMenu({roster, asOf: readNow(instant(new Date())), json}));
	}),
).pipe(
	Command.withShortDescription("The landed skill roster, derived from the installed plugin."),
	Command.withDescription(
		"List the landed skill roster, derived from the installed plugin's skills tree rather than from a committed file. First stdout line is `menu\\t<ready|empty>\\t<count>\\t<as-of>`, then one `skill\\t<name>\\t<invocation>\\t<model|user>\\t<description>` line each. An implicitly-resolved roster holding zero skills is `empty` at exit 0. Exits 7 (an explicitly passed --skills-dir is proven absent), 11 (the resolved roster could not be read — UNKNOWN, never empty). Example: fabrika status menu",
	),
);

const settings = leafCommand(
	"settings",
	{
		root: Flag.string("root").pipe(
			Flag.optional,
			Flag.withDescription(
				"the directory holding .fabrika.jsonc (default: the repository root, else the cwd)",
			),
		),
		surfaces: Flag.boolean("surfaces").pipe(
			Flag.withDescription(
				"expand `surfaceDispositions` into one `surface` row per repo surface, each with the disposition this repo resolves to and what that surface is",
			),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({root, surfaces, json}) {
		const source = yield* configSurface(Option.getOrNull(root));
		yield* emit(
			runSettings({
				source,
				rows: settingRows(source),
				asOf: readNow(instant(new Date())),
				json,
				surfaces,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The resolved config surface, every key with its provenance."),
	Command.withDescription(
		"Print every key on the config surface with its resolved value and where that value came from — the one place a skill asks what `.fabrika.jsonc` resolves to, so no document has to restate a value. First stdout line is `settings\\t<resolved|unknown>\\t<keys>\\t<declared>\\t<unknown>\\t<as-of>`, then one `setting\\t<key>\\t<declared|default|unknown>\\t<value-as-json>\\t<detail>\\t<as-of>` line each. A repo with no `.fabrika.jsonc` prints the full shipped-default set at exit 0; a key whose value could not be established makes the whole readout a refusal that names each UNKNOWN key on stderr, never the default it did not resolve to. Pass --surfaces to expand `surfaceDispositions` into one `surface\\t<id>\\t<fail-loud|degrade|bootstrap>\\t<what the surface is>` line per repo surface, appended to the same readout — the id-to-word value alone says nothing about what a surface is, and that half is what an operator relays. This verb writes nothing. Exits 7 (the config surface registers zero keys, or --surfaces was passed and no `surfaceDispositions` key is registered — ADR 0092), 11 (the repository root could not be resolved, or `.fabrika.jsonc` exists and could not be read, is not a JSON object, holds a value the surface refuses, or refused the whole load — UNKNOWN, never green). Example: fabrika status settings",
	),
);

const wiring = leafCommand(
	"wiring",
	{
		root: Flag.string("root").pipe(
			Flag.optional,
			Flag.withDescription(
				"the directory holding .claude/settings.json (default: the repository root above the cwd)",
			),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({root, json}) {
		const named = Option.getOrNull(root);
		const source =
			named === null ? yield* repoWiringSource(process.cwd()) : yield* readWiringSource(named);
		yield* emit(
			runWiring({source, read: wiringOf(source), asOf: readNow(instant(new Date())), json}),
		);
	}),
).pipe(
	Command.withShortDescription("Whether this repo's sessions load fabrika's skills at all."),
	Command.withDescription(
		"Answer whether the fabrika plugin is wired into this repo — the meta-precondition no other status verb covers, because every one of them answers about something the CLI reads and the CLI answers fine in a repo where no fabrika skill can load (#6443). Reads `.claude/settings.json` at the repository root and reports the `enabledPlugins` entry naming fabrika together with the marketplace source that key's `plugin@marketplace` form carries. Stdout is the single line `wiring\t<wired|unwired>\t<entry>\t<marketplace>\t<detail>\t<as-of>`. An absent settings.json, a file declaring no enabledPlugins block, an entry switched off, and a bare `fabrika` key naming no marketplace are all the proven negative `unwired` at exit 0 — a fact the caller acts on, never a green. This verb writes nothing; creating the file is `status bootstrap`'s. Exits 11 (the repository root could not be resolved, or settings.json exists and could not be read, is not JSON, is not an object, declares a non-object enabledPlugins, or carries a fabrika entry that is neither true nor false — UNKNOWN, never unwired). Example: fabrika status wiring",
	),
);

const board = leafCommand(
	"board",
	{repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({repo, json}) {
		const target = yield* resolveTarget(Option.getOrNull(repo));
		if (target._tag === "Failure") {
			yield* emit(
				runBoard({
					read: {_tag: "Failed", repo: "the target repo", reason: target.reason},
					json,
				}),
			);
			return;
		}
		yield* emit(runBoard({read: yield* readBoard(target.value, () => new Date()), json}));
	}),
).pipe(
	Command.withShortDescription("The board's decided buckets, each with its own freshness."),
	Command.withDescription(
		"Count the board's decided buckets over named REST endpoints — needs-triage, triaged, in-flight and one per priority — each with its own freshness. An absent label renders `unknown` with detail `label absent`, never 0. First stdout line is `board\\t<counted|unknown>\\t<bucket-count>`, then one `bucket\\t…` line each. Exits 11 (the repository could not be read at all — every bucket is UNKNOWN). Example: fabrika status board",
	),
);

const readout = leafCommand(
	"readout",
	{
		issue: Argument.string("issue").pipe(
			Argument.optional,
			Argument.withDescription(
				'the artifact issue number (default: $FABRIKA_GOVERNANCE_READOUT_ISSUE, else the single open issue titled exactly "Governance readout")',
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, repo, json}) {
		const supplied = Option.getOrNull(issue);
		const number = supplied === null ? null : issueNumberOf(supplied);
		if (supplied !== null && number === null) {
			yield* emit(badIssueRefusal(supplied));
			return;
		}
		const target = yield* resolveTarget(Option.getOrNull(repo));
		const read = yield* readReadout({
			repo: target._tag === "Ok" ? target.value : "",
			issue: number,
			env: process.env,
		});
		yield* emit(runReadout({read, json}));
	}),
).pipe(
	Command.withShortDescription("The landed-decision digest from the durable artifact."),
	Command.withDescription(
		"Display the landed-decision digest published in the durable artifact, decoded through the registered governance-digest wire format. This verb ranks nothing. First stdout line is `readout\\t<found|absent|malformed>\\t<row-count>\\t<source>\\t<as-of>`, then the digest's own rows. A closed or absent artifact is `absent` at exit 0. Exits 10 (the positional is not a positive issue number), 11 (the artifact could not be fetched, its updated_at was unreadable, or the format is not registered — UNKNOWN, never absent). Example: fabrika status readout",
	),
);

const bootstrap = leafCommand(
	"bootstrap",
	{
		surface: Argument.string("surface-id").pipe(
			Argument.withDescription(`one id from the buildable-surface registry: ${knownIds()}`),
		),
		path: Flag.string("path").pipe(
			Flag.optional,
			Flag.withDescription(
				"override the target path for a file, line, json or dep-pin surface; must resolve inside the repository root",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({surface, path, repo, json}) {
		yield* emit(
			yield* runBootstrap({
				surfaceId: surface,
				path: Option.getOrNull(path),
				json,
				repoRoot: yield* repositoryRoot,
				configSource: yield* repoConfigSource(process.cwd()),
				repo: yield* resolveTarget(Option.getOrNull(repo)),
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Create one missing repo surface and read it back."),
	Command.withDescription(
		"Create one missing repo surface from this group's own buildable-surface registry and read it back. The content of a file surface arrives on STDIN — the write, the collision guard and the read-back are this verb's; what the file says is the skill's. A line surface (`gitignore-row`, `claude-md-section`) instead appends its own registry row to a file the repo already owns, reads no STDIN, and rewrites nothing that is already there. A json surface (`settings-patch`) carries its own keys in the registry: a present file has them merged into the parsed object — every undeclared key preserved, bytes that do not parse refused unwritten — and an absent file is written whole; it reads no STDIN either way. A dep-pin surface (`dep-pin`) resolves the package's current published version from the npm registry at run time, merges the dependency row into the manifest at exactly that version, and prints the install command — no package manager ever runs and no lockfile is read or written; an unreachable registry refuses unwritten. A target already present in its adopted form is `exists` at exit 0 and nothing is written. Stdout is the single line `bootstrap\\t<created|exists>\\t<surface-id>\\t<target>\\t<readback>`. Exits 3 (stdin held nothing), 5 (the content carries a machine-local path), 6 (the content is a bare @ path reference), 8 (the write failed — UNKNOWN), 9 (the read-back differs), 10 (--path resolves outside the repository root), 11 (the existence probe failed, a present json target does not parse as a JSON object, or the npm registry could not be reached — nothing was written), 12 (the surface is not in the registry). Example: fabrika status bootstrap readout-artifact",
	),
);

const open = leafCommand(
	"open",
	{
		field: Flag.string("field").pipe(
			Flag.optional,
			Flag.withDescription(`render one field only: ${FIELDS.join(", ")}`),
		),
		repo: repoFlag,
		skillsDir: skillsDirFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({field, repo, skillsDir, json}) {
		const only = Option.getOrNull(field);
		if (only !== null && !isFieldName(only)) {
			yield* emit(badFieldRefusal(only));
			return;
		}
		const wanted = only === null ? FIELDS : [only];
		const asOf = readNow(instant(new Date()));
		const target: Attempt<string> = yield* resolveTarget(Option.getOrNull(repo));
		const repoName = target._tag === "Ok" ? target.value : "unresolved";

		const roster = wanted.includes("menu")
			? yield* readRoster(rosterSources(Option.getOrNull(skillsDir)))
			: null;

		const fields: Field[] = [];
		for (const name of wanted) {
			if (name === "menu" && roster !== null) fields.push(menuField(roster, asOf));
			if (name === "settings") {
				const source = yield* configSurface(null);
				fields.push(settingsField(settingRows(source), CONFIG_PATH, asOf));
			}
			if (name === "wiring") {
				const source = yield* repoWiringSource(process.cwd());
				fields.push(wiringField(wiringOf(source), asOf));
			}
			if (name === "board") {
				fields.push(
					boardField(
						target._tag === "Ok"
							? yield* readBoard(target.value, () => new Date())
							: {_tag: "Failed", repo: repoName, reason: target.reason},
					),
				);
			}
			if (name === "readout") {
				fields.push(
					readoutField(
						target._tag === "Ok"
							? yield* readReadout({repo: target.value, issue: null, env: process.env})
							: {_tag: "Unfetchable", repo: repoName, issue: null, reason: target.reason},
					),
				);
			}
			if (name === "lanes") {
				const roots = [DEFAULT_LANES_ROOT, DEFAULT_CHORES_ROOT];
				fields.push(
					lanesField(
						yield* runStale({
							roots,
							olderThanMinutes: DEFAULT_STALE_MINUTES,
							now: new Date().toISOString(),
							// The front door renders on a cold start and must not wait on the board for it.
							claims: null,
						}),
						roots,
						asOf,
					),
				);
			}
		}
		const rosterScope =
			roster === null
				? "roster not read"
				: `roster ${roster.display}${roster._tag === "Resolved" ? ` (${roster.tier})` : " (unresolved)"}`;
		yield* emit(runOpen({fields, json, scope: `${rosterScope}; repo ${repoName}`}));
	}),
).pipe(
	Command.withShortDescription(
		"The composite readout: menu, settings, wiring, board, readout, lanes.",
	),
	Command.withDescription(
		"The composite front-door readout: six fields — menu, settings, wiring, board, readout, lanes — each with its own state, source and freshness. The wiring field says whether this repo's `.claude/settings.json` enables the fabrika plugin at all, which is what makes the difference between a repo the CLI answers in and a repo whose sessions can load a skill. The lanes field renders `fabrika lane stale`'s sweep over both default roots at its documented threshold: `stale` names the silent lanes, zero stale lanes is the proven negative `empty` (no lanes on disk is `empty` too), and an unreadable root or lane record is `unknown` with its reason — it reports, it never resumes. Every unreadable source becomes a field state, so this verb has no zero-scope seat and no failed-read seat: it is injected before the session reads a token and a refusal would write zero bytes. First stdout line is `open\\t<field-count>`, then one `field\\t<name>\\t<state>\\t<detail>\\t<source>\\t<as-of>` line each. Exits 10 (--field is off the closed vocabulary). Example: fabrika status open",
	),
);

export const statusCommand = Command.make("status").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing
		// one. The comment is what keeps the formatter from collapsing the list back.
		open,
		settings,
		wiring,
		menu,
		readout,
		board,
		bootstrap,
	]),
	Command.withShortDescription("Answer what state the factory is in."),
	Command.withDescription(
		"Answer what state the factory is in — the composite front-door readout, the resolved `.fabrika.jsonc` config surface, whether the plugin carrying the skills is enabled here, the derived skill roster, the landed-decision digest, the board's bucket counts, and the one primitive that creates a missing surface",
	),
);
