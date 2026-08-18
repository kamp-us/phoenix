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
import {fileURLToPath} from "node:url";
import {Effect, type FileSystem, Option, type Path} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {discoverRepoRoot} from "../delegate/root.ts";
import {leafCommand} from "../excess-operand.ts";
import type {Attempt} from "../io/git.ts";
import {listLabels, resolveRepo} from "../io/issues.ts";
import {readStdin} from "../io/stdin.ts";
import {DEFAULT_STALE_MINUTES} from "../lane/stale.ts";
import {runStale} from "../lane/stale-verb.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT} from "../lane/store.ts";
import type {VerbOutcome} from "../verb.ts";
import {readBoard, runBoard} from "./board-verb.ts";
import {knownIds, runBootstrap} from "./bootstrap-verb.ts";
import {labelSetOf, probeSurfaces, runConfig, type SurfaceRow} from "./config-verb.ts";
import {instant, readNow} from "./fields.ts";
import {runMenu} from "./menu-verb.ts";
import {
	badFieldRefusal,
	boardField,
	configField,
	FIELDS,
	type Field,
	isFieldName,
	lanesField,
	menuField,
	readoutField,
	runOpen,
} from "./open-verb.ts";
import {badIssueRefusal, issueNumberOf, readReadout, runReadout} from "./readout-verb.ts";
import {type RosterSources, readRoster} from "./roster.ts";

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
		"the roster root to read (default: the installed plugin's own skills tree, else claude-plugins/fabrika/skills beneath the repo root, else the same path beneath the checkout the CLI itself runs from)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

/** The roster sources this invocation resolves against — the module's own location and the cwd. */
const rosterSources = (explicit: string | null): RosterSources => ({
	explicit,
	moduleDir: fileURLToPath(new URL(".", import.meta.url)),
	cwd: process.cwd(),
});

/**
 * The repository root a declared path is probed against, falling back to the cwd.
 *
 * The fallback is safe here and only here: a probe rooted at the cwd answers about *some* real
 * directory, and every row it produces says which path it looked at. Nothing is reported present
 * that was not found.
 */
const repositoryRoot: Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> = Effect.gen(
	function* () {
		const found = yield* Effect.result(discoverRepoRoot(process.cwd()));
		return found._tag === "Success" ? (found.success ?? process.cwd()) : process.cwd();
	},
);

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

const config = leafCommand(
	"config",
	{
		skill: Flag.string("skill").pipe(Flag.optional),
		skillsDir: skillsDirFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({skill, skillsDir, repo, json}) {
		const roster = yield* readRoster(rosterSources(Option.getOrNull(skillsDir)));
		if (roster._tag !== "Resolved") {
			yield* emit(runConfig({roster, surfaces: [], json}));
			return;
		}
		const target = yield* resolveTarget(Option.getOrNull(repo));
		const labels = target._tag === "Ok" ? yield* listLabels(target.value) : null;
		const surfaces = yield* probeSurfaces({
			roster,
			only: Option.getOrNull(skill),
			ctx: {
				repoRoot: yield* repositoryRoot,
				labels: labelSetOf(labels),
				repoName: target._tag === "Ok" ? target.value : "the target repo",
				asOf: readNow(instant(new Date())),
			},
		});
		yield* emit(runConfig({roster, surfaces, json}));
	}),
).pipe(
	Command.withShortDescription("Which repo surfaces the landed skills need, and which exist."),
	Command.withDescription(
		"Report which repo surfaces every landed skill declares it needs and whether each is present here — the detection verb (#4952). First stdout line is `config\\t<satisfied|gaps|unknown>\\t<declared>\\t<missing>\\t<undeclared>\\t<off-vocabulary>`, then one `surface\\t…` line per declared row. A skill with no `## Required repo files` section emits one `undeclared` row, never zero. Exits 7 (an explicitly passed --skills-dir is proven absent), 11 (the roster or a SKILL.md inside it could not be read — the declaration set is UNKNOWN). Example: fabrika status config",
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
				"override the write path for a file surface; must resolve inside the repository root",
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
				repo: yield* resolveTarget(Option.getOrNull(repo)),
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Create one missing repo surface and read it back."),
	Command.withDescription(
		"Create one missing repo surface from this group's own buildable-surface registry and read it back. The content of a file surface arrives on STDIN — the write, the collision guard and the read-back are this verb's; what the file says is the skill's. A target already present is `exists` at exit 0 and nothing is written. Stdout is the single line `bootstrap\\t<created|exists>\\t<surface-id>\\t<target>\\t<readback>`. Exits 3 (stdin held nothing), 5 (the content carries a machine-local path), 6 (the content is a bare @ path reference), 8 (the write failed — UNKNOWN), 9 (the read-back differs), 10 (--path resolves outside the repository root), 11 (the existence probe failed — nothing was written), 12 (the surface is not in the registry). Example: fabrika status bootstrap readout-artifact",
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

		const needsRoster = wanted.includes("menu") || wanted.includes("config");
		const roster = needsRoster
			? yield* readRoster(rosterSources(Option.getOrNull(skillsDir)))
			: null;

		const fields: Field[] = [];
		let surfaces: ReadonlyArray<SurfaceRow> = [];
		if (roster !== null && roster._tag === "Resolved" && wanted.includes("config")) {
			const labels = target._tag === "Ok" ? yield* listLabels(target.value) : null;
			surfaces = yield* probeSurfaces({
				roster,
				only: null,
				ctx: {
					repoRoot: yield* repositoryRoot,
					labels: labelSetOf(labels),
					repoName,
					asOf,
				},
			});
		}
		for (const name of wanted) {
			if (name === "menu" && roster !== null) fields.push(menuField(roster, asOf));
			if (name === "config" && roster !== null) fields.push(configField(roster, surfaces, asOf));
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
		"The composite front-door readout: menu, config, board, readout, lanes.",
	),
	Command.withDescription(
		"The composite front-door readout: five fields — menu, config, board, readout, lanes — each with its own state, source and freshness. The lanes field renders `fabrika lane stale`'s sweep over both default roots at its documented threshold: `stale` names the silent lanes, zero stale lanes is the proven negative `empty` (no lanes on disk is `empty` too), and an unreadable root or lane record is `unknown` with its reason — it reports, it never resumes. Every unreadable source becomes a field state, so this verb has no zero-scope seat and no failed-read seat: it is injected before the session reads a token and a refusal would write zero bytes. First stdout line is `open\\t<field-count>`, then one `field\\t<name>\\t<state>\\t<detail>\\t<source>\\t<as-of>` line each. Exits 10 (--field is off the closed vocabulary). Example: fabrika status open",
	),
);

export const statusCommand = Command.make("status").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing
		// one. The comment is what keeps the formatter from collapsing the list back.
		open,
		config,
		menu,
		readout,
		board,
		bootstrap,
	]),
	Command.withShortDescription("Answer what state the factory is in."),
	Command.withDescription(
		"Answer what state the factory is in — the composite front-door readout, the config-surface detection verb, the derived skill roster, the landed-decision digest, the board's bucket counts, and the one primitive that creates a missing surface",
	),
);
