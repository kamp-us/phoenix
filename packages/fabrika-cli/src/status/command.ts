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
import {CONFIG_PATH} from "../config/document.ts";
import type {ConfigLayers} from "../config/load.ts";
import {readConfigLayers} from "../config/source.ts";
import {repoConfigLayers, repoConfigSource} from "../config/working-root.ts";
import {discoverRepoRoot} from "../delegate/root.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import type {Attempt} from "../io/git.ts";
import {resolveRepo} from "../io/issues.ts";
import {readStdin} from "../io/stdin.ts";
import {runStale} from "../lane/stale-verb.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT} from "../lane/store.ts";
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
	Flag.withDefault(false),
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
): Effect.Effect<ConfigLayers, never, FileSystem.FileSystem | Path.Path> =>
	root === null ? repoConfigLayers(process.cwd()) : readConfigLayers(root);

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
		[
			"Lists the landed skill roster, derived from the installed plugin's skills tree.",
			"  stdout: `menu\\t<ready|empty>\\t<count>\\t<as-of>`, then one line per skill:",
			"  `skill\\t<name>\\t<invocation>\\t<model|user>\\t<description>`",
			"  7: an explicitly passed --skills-dir is absent",
			"  11: the roster could not be read (UNKNOWN, never empty)",
			'  Derivation: the front-door skill\'s contract.md, "status menu"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika status menu"}]),
);

const settings = leafCommand(
	"settings",
	{
		root: Flag.string("root").pipe(
			Flag.optional,
			Flag.withDescription(
				"the directory holding .fabrika.jsonc and .fabrika.local.jsonc (default: the repository root, else the cwd)",
			),
		),
		surfaces: Flag.boolean("surfaces").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"expand `surfaceDispositions` into one `surface\\t<id>\\t<fail-loud|degrade|bootstrap>\\t<what the surface is>` row per repo surface, appended to the same readout, each with the disposition this repo resolves to",
			),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({root, surfaces, json}) {
		const layers = yield* configSurface(Option.getOrNull(root));
		yield* emit(
			runSettings({
				layers,
				rows: settingRows(layers),
				asOf: readNow(instant(new Date())),
				json,
				surfaces,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The resolved config surface, every key with its provenance."),
	Command.withDescription(
		[
			"Prints every config key with its resolved value and the file or default it came from.",
			"  stdout: `settings\\t<resolved|unknown>\\t<keys>\\t<declared>\\t<unknown>\\t<as-of>`, then",
			"  `setting\\t<key>\\t<declared|default|unknown>\\t<value-as-json>\\t<detail>\\t<as-of>` per key",
			"  7: no keys registered, or --surfaces finds no `surfaceDispositions` key",
			"  11: the root or a config file could not be read or resolved (UNKNOWN)",
			'  Derivation: the front-door skill\'s contract.md, "status settings"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika status settings"},
		{command: "fabrika status settings --surfaces"},
	]),
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
		[
			"Prints whether this repo's `.claude/settings.json` enables the fabrika plugin.",
			"  stdout: `wiring\\t<wired|unwired>\\t<entry>\\t<marketplace>\\t<detail>\\t<as-of>`",
			"  11: the root or settings.json could not be read or parsed (UNKNOWN, never unwired)",
			'  Derivation: the front-door skill\'s contract.md, "status wiring"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika status wiring"}]),
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
		[
			"Counts the board's decided buckets, each with its own freshness.",
			"  stdout: `board\\t<counted|unknown>\\t<bucket-count>`, then one `bucket\\t…` line each",
			"  11: the repository could not be read (every bucket UNKNOWN)",
			'  Derivation: the front-door skill\'s contract.md, "status board"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika status board"}]),
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
		[
			"Prints the landed-decision digest published in the durable governance readout artifact.",
			"  stdout: `readout\\t<found|absent|malformed>\\t<row-count>\\t<source>\\t<as-of>`, then its rows",
			"  10: the positional is not a positive issue number",
			"  11: the artifact or its format could not be read (UNKNOWN, never absent)",
			'  Derivation: the front-door skill\'s contract.md, "status readout"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika status readout"}]),
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
		[
			"Creates one missing repo surface from the buildable-surface registry and reads it back.",
			"  stdout: `bootstrap\\t<created|exists>\\t<surface-id>\\t<target>\\t<readback>`",
			"  Only a file surface reads its content on stdin.",
			"  3: stdin held nothing",
			"  5: the content carries a machine-local path",
			"  6: the content is a bare @ path reference",
			"  8: the write failed (UNKNOWN)",
			"  9: the read-back differs",
			"  10: --path resolves outside the repository root",
			"  11: a precondition read failed; nothing written",
			"  12: the surface is not in the registry",
			'  Derivation: the front-door skill\'s contract.md, "status bootstrap"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika status bootstrap readout-artifact"}]),
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
				const layers = yield* configSurface(null);
				fields.push(settingsField(settingRows(layers), CONFIG_PATH, asOf));
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
							// Each lane is judged against its own shell budget; the front door has no horizon of
							// its own to impose.
							olderThanMinutes: null,
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
		[
			"Prints the composite front-door readout: menu, settings, wiring, board, readout and lanes.",
			"  stdout: `open\\t<field-count>`, then `field\\t<name>\\t<state>\\t<detail>\\t<source>\\t<as-of>` each",
			"  10: --field is off the closed vocabulary",
			'  Derivation: the front-door skill\'s contract.md, "status open"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika status open"}]),
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
