#!/usr/bin/env node
/**
 * `pipeline-crew-mcp` — the substrate's entry bin (epic #3045, scaffold #3052; cutover #3062).
 *
 *   node src/bin.ts                                  # the root command (no seam wired)
 *   node src/bin.ts session --role <role>            # run one live crew session (stdio MCP)
 *
 * The `session` subcommand is the runnable stdio MCP entry (#3062): it stands up one live crew
 * session's `McpServer` over stdio + its channel peer, so the crew's inter-session seams run over
 * the channels protocol. `--role` is one of the five standing `CREW_ROLES` (the roster is the
 * single source — the flag chooses from it, never a re-declared list); the session joins the
 * per-project tracker at `--project-root` (default: cwd). It runs until interrupted.
 *
 * NB: an MCP stdio server owns stdout for JSON-RPC, so the one startup line goes to STDERR — a
 * log on stdout would corrupt the protocol stream.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/pipeline-cli`'s bin): `effect/unstable/cli`
 * for the typed command, the Node platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";

import {CREW_ROLES, RoleUniquenessError, runCrewSession} from "./crew/index.ts";
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

const cli = Command.make(
	"pipeline-crew-mcp",
	{},
	Effect.fn(function* () {
		yield* Console.error(
			`pipeline-crew-mcp ${VERSION} — run \`session --role <role>\` to start a live crew session`,
		);
	}),
).pipe(
	Command.withDescription("The crew's channels-backed messaging substrate (epic #3045)"),
	Command.withSubcommands([session]),
);

cli.pipe(Command.run({version: VERSION}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
