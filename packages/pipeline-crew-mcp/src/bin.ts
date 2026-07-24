#!/usr/bin/env node
/**
 * `pipeline-crew-mcp` — the substrate's entry bin (epic #3045, scaffold #3052; cutover #3062).
 *
 *   node src/bin.ts                                  # the root command (no seam wired)
 *   node src/bin.ts session --role <role>            # run one live crew session (stdio MCP)
 *   node src/bin.ts tracker                           # run a standalone per-project tracker
 *   node src/bin.ts stand-up                          # stand the whole crew up from the operator config
 *   node src/bin.ts stand-down                        # tear down the crew's project-scope .mcp.json + server approval
 *   node src/bin.ts spawn-role <role>                 # add ONE member to the running crew (no whole-crew re-boot)
 *   node src/bin.ts retire-role <role> [--instance]   # retire ONE member (kill its pane + reclaim its artifacts)
 *   node src/bin.ts doctor [--reap]                   # report crew channel health (registered/channel-deaf/orphaned) + reap
 *
 * The `spawn-role` / `retire-role` subcommands are the single-member membership ops (#3519): dynamic
 * add/remove/respawn of ONE crew member without the whole-crew re-boot `stand-up`/`stand-down` force.
 * `spawn-role` reuses the whole-crew per-role launch step but SPLITS the pane into the running crew
 * window; `retire-role` kills one member's pane (its role lease frees by TTL) and reclaims its inbox
 * socket + launcher cwd. The runtime already does the join/leave/discover (crew/session.ts + tracker.ts);
 * these subcommands are the missing CLI surface over it. See `standup/single-role.ts`.
 *
 * The `session` subcommand is the runnable stdio MCP entry (#3062): it stands up one live crew
 * session's `McpServer` over stdio + its channel peer, so the crew's inter-session seams run over
 * the channels protocol. `--role` is one of the five standing `CREW_ROLES` (the roster is the
 * single source — the flag chooses from it, never a re-declared list); the session joins the
 * per-project tracker at `--project-root` (default: cwd), first-peer-spawn hosting it if no peer
 * has yet. It runs until interrupted.
 *
 * The `tracker` subcommand stands a project's tracker up on its own (`launchTracker`), decoupled
 * from any role session — the explicit way to pre-warm or keep a registry alive across session
 * restarts. It is idempotent: if a tracker already serves the project it reports so and exits 0.
 *
 * The `stand-up` subcommand is the one stand-up command (ADR 0192, issue #3299): it reads the
 * operator crew config and boots the whole crew — tracker + every bridge + N engine sessions — via
 * the `standup/` orchestration (`runStandUp`), fail-loud with no partial crew. The distributable
 * plugin's thin `commands/stand-up.md` invokes this subcommand; the launcher logic lives here in the
 * substrate, never duplicated in the plugin (ADR 0192 decision B).
 *
 * The `stand-down` subcommand is its symmetric teardown (issue #3444): stand-up registers each pane's
 * crew server as a project-scope leaf `.mcp.json` (the channel-ref resolver reads persisted scopes only,
 * never inline `--mcp-config`) and seeds two boot gates (folder trust + the server's `enabledMcpjsonServers`
 * approval); stand-down removes the launcher-owned per-pane cwd dirs (the `.mcp.json` with them) and
 * revokes the server approval. A start-of-stand-up reaper also runs inside `runStandUp` so a crashed
 * launcher's leftovers are cleared on the next boot regardless.
 *
 * NB: an MCP stdio server owns stdout for JSON-RPC, so the one startup line goes to STDERR — a
 * log on stdout would corrupt the protocol stream.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/pipeline-cli`'s bin): `effect/unstable/cli`
 * for the typed command, the Node platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Cause, Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";

import {
	CREW_ROLES,
	collectLiveRegisteredForProject,
	RoleUniquenessError,
	renderCrewChannelHealth,
	runCrewChannelDoctor,
	runCrewSession,
} from "./crew/index.ts";
import {
	CREW_WINDOW,
	renderStandUpError,
	renderTaggedError,
	retireRole,
	runStandDown,
	runStandUp,
	spawnRole,
} from "./standup/index.ts";
import {isTrackerAddressInUse, launchTracker} from "./tracker/index.ts";
import {VERSION} from "./version.ts";

const roleFlag = Flag.choice("role", CREW_ROLES).pipe(
	Flag.withDescription("the standing crew role this session serves (one of the five CREW_ROLES)"),
);
const projectRootFlag = Flag.string("project-root").pipe(
	Flag.withDefault(process.cwd()),
	Flag.withDescription(
		"a directory inside the repo whose tracker this session joins; seeds git repo discovery only — the rendezvous is the repo's canonical one (ADR 0197)",
	),
);
// The launcher-assigned per-instance identity standup/bind.ts bakes into an engine's argv
// (`CREW_SESSION_INSTANCE_FLAG`, #3297/#3354 seam 3). Optional: only engine roles carry it — a
// bridge is a singleton and omits it, so the session mints its own (see `sessionInstance`). This is
// the consumer the producer shipped without; without it Effect-CLI rejects `--instance` and every
// engine session dies at parse (#3445).
const instanceFlag = Flag.optional(Flag.string("instance")).pipe(
	Flag.withDescription("the launcher-assigned per-instance identity an engine session binds"),
);

const session = Command.make(
	"session",
	{projectRoot: projectRootFlag, role: roleFlag, instance: instanceFlag},
	Effect.fn(function* ({projectRoot, role, instance}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — crew session for role "${role}" (project ${projectRoot})`,
		);
		// Thread the flag through as an EXACT-optional key: include `instance` only when the launcher
		// passed one (an engine), omit it entirely otherwise (a bridge/singleton, or a direct run) so
		// `CrewSessionConfig.instance`'s absent case stays absent — `sessionInstance` then mints one.
		return yield* runCrewSession({
			projectRoot,
			role,
			...(Option.isSome(instance) ? {instance: instance.value} : {}),
		}).pipe(
			Effect.catch((error: unknown) =>
				Console.error(
					error instanceof RoleUniquenessError
						? `refusing to start: role "${error.role}" is already held by ${error.heldBy} (role-uniqueness lease)`
						: `crew session failed to start: ${String(error)}`,
				).pipe(Effect.andThen(Effect.sync(() => process.exit(1)))),
			),
		);
	}),
).pipe(Command.withDescription("Run one live crew session: stdio MCP server + channel peer"));

const tracker = Command.make(
	"tracker",
	{projectRoot: projectRootFlag},
	Effect.fn(function* ({projectRoot}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — standalone tracker for project ${projectRoot}`,
		);
		return yield* launchTracker(projectRoot).pipe(
			Effect.catchCause((cause) =>
				isTrackerAddressInUse(cause)
					? Console.error(`a tracker already serves project ${projectRoot} — nothing to do`)
					: Console.error(`tracker failed to start: ${String(Cause.squash(cause))}`).pipe(
							Effect.andThen(Effect.sync(() => process.exit(1))),
						),
			),
		);
	}),
).pipe(
	Command.withDescription("Run a standalone per-project tracker (the registry socket server)"),
);

const standUp = Command.make(
	"stand-up",
	{projectRoot: projectRootFlag},
	Effect.fn(function* ({projectRoot}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — standing up the crew from the operator config (project ${projectRoot})`,
		);
		// runStandUp reads every launch dimension — including the tmux placement dimension — from the
		// operator crew config itself (config.ts's typed reader, #3354 seam 1); nothing to inject here.
		return yield* runStandUp({projectRoot}).pipe(
			Effect.flatMap((result) =>
				Console.error(
					`crew up: tracker pid ${result.tracker.pid ?? "?"} on ${result.tracker.socketPath}; ${result.launched.length} panes launched in the ${CREW_WINDOW} window (${result.launched
						.map((s) => `${s.role}→${s.pane}`)
						.join(", ")})`,
				),
			),
			// Fail-loud, no partial crew: a bad config, a version drift, an unstartable tracker, an inert
			// channel, or a colliding pane label aborts naming its cause — renderStandUpError surfaces the
			// tagged error's rich fields (reason/role/pane), not just its tag (#3438).
			Effect.catch((error) =>
				Console.error(`stand-up aborted (no partial crew): ${renderStandUpError(error)}`).pipe(
					Effect.andThen(Effect.sync(() => process.exit(1))),
				),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Stand the whole crew up from the operator config (tracker + bridges + N engines), fail-loud",
	),
);

const standDown = Command.make(
	"stand-down",
	{projectRoot: projectRootFlag},
	Effect.fn(function* ({projectRoot}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — tearing down the crew's project-scope .mcp.json + server approval (project ${projectRoot})`,
		);
		// Symmetric to stand-up (#3444): remove the launcher-owned per-pane cwd dirs (the leaf `.mcp.json`
		// with them) + revoke the server approval. Idempotent — safe to run with no crew up, and while one is.
		return yield* runStandDown({projectRoot}).pipe(
			Effect.flatMap(() =>
				Console.error(
					`crew stood down: removed the project-scope crew .mcp.json + launcher cwd dirs and revoked the server approval for project ${projectRoot}`,
				),
			),
			Effect.catch((error) =>
				Console.error(`stand-down aborted: ${renderStandUpError(error)}`).pipe(
					Effect.andThen(Effect.sync(() => process.exit(1))),
				),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Tear down the crew's project-scope .mcp.json + server approval (symmetric to stand-up)",
	),
);

// The positional role a single-member membership op targets — any roster role (the `session --role`
// flag chooses from the SAME `CREW_ROLES` source; this is its positional twin for spawn/retire).
const roleArg = Argument.choice("role", CREW_ROLES).pipe(
	Argument.withDescription("the crew role to spawn/retire one member of (one of the CREW_ROLES)"),
);
// Which engine INSTANCE to retire — required for a cardinality-N engine, rejected for a singleton
// bridge (retireRole enforces the kind rule). Optional at the CLI so a bridge omits it.
const instanceFlagOptional = Flag.optional(Flag.string("instance")).pipe(
	Flag.withDescription(
		"the engine instance id to retire (required for an engine role, none for a bridge)",
	),
);

const spawnRoleCmd = Command.make(
	"spawn-role",
	{projectRoot: projectRootFlag, role: roleArg},
	Effect.fn(function* ({projectRoot, role}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — spawning one "${role}" member into the running crew (project ${projectRoot})`,
		);
		// Add ONE member to the running crew without a whole-crew re-boot (#3519): reuse the shared
		// per-role launch step, split into the running crew window, fail-loud if no crew is up.
		return yield* spawnRole({projectRoot, role}).pipe(
			Effect.flatMap((result) =>
				Console.error(
					`crew member up: ${result.launched.role}→${result.launched.pane} in window ${result.launched.window} (pid ${result.launched.pid ?? "?"})`,
				),
			),
			Effect.catch((error) =>
				Console.error(`spawn-role aborted: ${renderTaggedError(error)}`).pipe(
					Effect.andThen(Effect.sync(() => process.exit(1))),
				),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Add ONE crew member to the running crew (split into the crew window), no whole-crew re-boot",
	),
);

const retireRoleCmd = Command.make(
	"retire-role",
	{projectRoot: projectRootFlag, role: roleArg, instance: instanceFlagOptional},
	Effect.fn(function* ({projectRoot, role, instance}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — retiring one "${role}" member from the running crew (project ${projectRoot})`,
		);
		// Tear ONE member down cleanly: kill its pane (its lease frees by TTL), reclaim its inbox socket +
		// launcher cwd — leaving every other member running (#3519).
		return yield* retireRole({
			projectRoot,
			role,
			...(Option.isSome(instance) ? {instance: instance.value} : {}),
		}).pipe(
			Effect.flatMap((result) =>
				Console.error(
					`crew member retired: ${result.role}${result.instance ? `/${result.instance}` : ""} (killed pane ${result.paneId})`,
				),
			),
			Effect.catch((error) =>
				Console.error(`retire-role aborted: ${renderTaggedError(error)}`).pipe(
					Effect.andThen(Effect.sync(() => process.exit(1))),
				),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Retire ONE crew member (kill its pane + reclaim its artifacts), leaving the rest running",
	),
);

const reapFlag = Flag.boolean("reap").pipe(
	Flag.withDescription(
		"also reap the orphaned crew server procs the report names (drives the #C4 reaper)",
	),
);

const doctorCmd = Command.make(
	"doctor",
	{projectRoot: projectRootFlag, reap: reapFlag},
	Effect.fn(function* ({projectRoot, reap}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — crew channel doctor over the canonical rendezvous (project ${projectRoot})`,
		);
		// Dial the rendezvous for the live-registered (attached) set, then classify every roster role's
		// channel health and — with --reap — reap the orphans. The report goes to STDOUT (this is a plain
		// operator report, not an MCP stdio server), the one startup line to STDERR.
		const liveRegisteredAddresses = yield* collectLiveRegisteredForProject(projectRoot);
		return yield* runCrewChannelDoctor({liveRegisteredAddresses, reap}).pipe(
			Effect.flatMap((result) => Console.log(renderCrewChannelHealth(result))),
			Effect.catch((error: unknown) =>
				Console.error(`crew doctor failed: ${String(error)}`).pipe(
					Effect.andThen(Effect.sync(() => process.exit(1))),
				),
			),
		);
	}),
).pipe(
	Command.withDescription(
		"Report crew channel health (registered / channel-deaf / orphaned) over the rendezvous, and --reap the orphans",
	),
);

const cli = Command.make(
	"pipeline-crew-mcp",
	{},
	Effect.fn(function* () {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — run \`stand-up\` to boot the crew, or \`session --role <role>\` for one session`,
		);
	}),
).pipe(
	Command.withDescription("The crew's channels-backed messaging substrate (epic #3045)"),
	Command.withSubcommands([
		session,
		tracker,
		standUp,
		standDown,
		spawnRoleCmd,
		retireRoleCmd,
		doctorCmd,
	]),
);

cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
