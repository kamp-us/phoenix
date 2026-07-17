#!/usr/bin/env node
/**
 * `pipeline-crew-mcp` — the substrate's entry bin (epic #3045, scaffold #3052; cutover #3062).
 *
 *   node src/bin.ts                                  # the root command (no seam wired)
 *   node src/bin.ts session --role <role>            # run one live crew session (stdio MCP)
 *   node src/bin.ts tracker                           # run a standalone per-project tracker
 *   node src/bin.ts stand-up                          # stand the whole crew up from the operator config
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
 * NB: an MCP stdio server owns stdout for JSON-RPC, so the one startup line goes to STDERR — a
 * log on stdout would corrupt the protocol stream.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/pipeline-cli`'s bin): `effect/unstable/cli`
 * for the typed command, the Node platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {readFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Cause, Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";

import {CREW_ROLES, RoleUniquenessError, runCrewSession} from "./crew/index.ts";
import {
	LaunchConfigError,
	parseJsonc,
	resolveConfigPath,
	runStandUp,
	type TmuxNaming,
} from "./standup/index.ts";
import {isTrackerAddressInUse, launchTracker} from "./tracker/index.ts";
import {VERSION} from "./version.ts";

const roleFlag = Flag.choice("role", CREW_ROLES).pipe(
	Flag.withDescription("the standing crew role this session serves (one of the five CREW_ROLES)"),
);
const projectRootFlag = Flag.string("project-root").pipe(
	Flag.withDefault(process.cwd()),
	Flag.withDescription("the project root whose per-project tracker socket this session joins"),
);

const session = Command.make(
	"session",
	{projectRoot: projectRootFlag, role: roleFlag},
	Effect.fn(function* ({projectRoot, role}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — crew session for role "${role}" (project ${projectRoot})`,
		);
		return yield* runCrewSession({projectRoot, role}).pipe(
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

/**
 * Read the operator's tmux naming (session + per-window names) from the crew config. The typed,
 * validated tmux-dimension reader is tracked separately (config.ts reads only the launch dimensions
 * today); this thin entrypoint marshal threads the operator's `tmux` block through to the
 * orchestration, which fails loud on any bridge window it cannot name. Resolves the config path by
 * the same `$CREW_CONFIG` → `.claude/crew.config.jsonc` order as the launch-dimension reader.
 */
const readTmuxNaming = (
	env: {readonly CREW_CONFIG?: string | undefined} = process.env,
): Effect.Effect<TmuxNaming, LaunchConfigError> =>
	Effect.gen(function* () {
		const configPath = resolveConfigPath(env);
		const text = yield* Effect.try({
			try: () => readFileSync(configPath, "utf8"),
			catch: (cause) =>
				new LaunchConfigError({
					configPath,
					reason: `cannot read crew config (run pipeline-crew stand-up first): ${String(cause)}`,
				}),
		});
		const parsed = yield* Effect.try({
			try: () => parseJsonc(text),
			catch: (cause) =>
				new LaunchConfigError({configPath, reason: `invalid JSONC: ${String(cause)}`}),
		});
		const tmux = (
			parsed as {readonly tmux?: {readonly session?: unknown; readonly windows?: unknown}}
		).tmux;
		if (
			tmux === undefined ||
			typeof tmux.session !== "string" ||
			tmux.windows === null ||
			typeof tmux.windows !== "object"
		) {
			return yield* new LaunchConfigError({
				configPath,
				reason:
					"missing or malformed `tmux` dimension — expected { session: string, windows: {...} }",
			});
		}
		return {session: tmux.session, windows: tmux.windows as Readonly<Record<string, string>>};
	});

const standUp = Command.make(
	"stand-up",
	{projectRoot: projectRootFlag},
	Effect.fn(function* ({projectRoot}) {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — standing up the crew from the operator config (project ${projectRoot})`,
		);
		const tmuxNaming = yield* readTmuxNaming();
		return yield* runStandUp({projectRoot, tmuxNaming}).pipe(
			Effect.flatMap((result) =>
				Console.error(
					`crew up: tracker pid ${result.tracker.pid ?? "?"} on ${result.tracker.socketPath}; ${result.launched.length} sessions launched (${result.launched
						.map((s) => `${s.role}→${s.window}`)
						.join(", ")})`,
				),
			),
			// Fail-loud, no partial crew: a bad config, a version drift, an unstartable tracker, an inert
			// channel, or an unnamed/colliding window aborts naming its cause — String(error) carries the tag.
			Effect.catch((error: unknown) =>
				Console.error(`stand-up aborted (no partial crew): ${String(error)}`).pipe(
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
	Command.withSubcommands([session, tracker, standUp]),
);

cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
