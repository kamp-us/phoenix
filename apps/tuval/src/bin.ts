/**
 * `tuval` — the bin: one Effect CLI root command over the pure `boot` (#7548).
 *
 *   node src/bin.ts                         # boot from ~/.tuval and ./.tuval, run until Ctrl-C
 *   node src/bin.ts --config <module>       # another global config module
 *   node src/bin.ts --project <dir>         # another project dir (its .tuval/ config and state)
 *   node src/bin.ts --help
 *
 * Ctrl-C is `NodeRuntime.runMain`'s interrupt: it interrupts the main fiber, whose Scope closing
 * stops and checkpoints every process. That stop is the documented way out, so it exits 0 rather
 * than the runner's default 130.
 */

import {dirname} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Cause, Console, Effect, Exit, Option, Runtime} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {boot, defaultGlobalConfig} from "./boot.ts";
import {renderBindingErrors} from "./commands/bindings/index.ts";
import {servePage} from "./page/dev-server.ts";
import {serveDesk} from "./shell/host/index.ts";
import {ProcessTablePort} from "./table/ProcessTablePort.ts";
import type {TableRow} from "./table/row.ts";

/** The app's own directory — `index.html`'s home, and so the page server's root. */
const appRoot = dirname(import.meta.dirname);

/** One table row as the terminal shows it: the port's row, nothing program-specific. */
export const renderRow = (row: TableRow): string => {
	const parent = Option.getOrElse(row.parentId, () => "-");
	const ports = Object.entries(row.ports)
		.map(([name, port]) => `${name}:${port.direction}(${port.kind})`)
		.join(",");
	return `tuval: process ${row.id} program=${row.programId} parent=${parent} ports=${ports || "-"} state=${row.stateSummary.lifecycle}@${row.stateSummary.revision}`;
};

/** Already printed as one line on stderr; the runner must neither log it again nor exit 0. */
class BootRefused extends Error {
	override readonly [Runtime.errorReported] = false;
	override readonly [Runtime.errorExitCode] = 1;
}

const tuval = Command.make(
	"tuval",
	{
		config: Flag.file("config", {mustExist: true}).pipe(
			Flag.withDescription("Global config module (default: ~/.tuval/tuval.config.ts)"),
			Flag.optional,
		),
		project: Flag.directory("project", {mustExist: true}).pipe(
			Flag.withDescription(
				"Project dir whose .tuval/ holds the project config and state (default: cwd)",
			),
			Flag.optional,
		),
		noPage: Flag.boolean("no-page").pipe(
			Flag.withDescription("Boot the kernel and the socket, but serve no page"),
			Flag.withDefault(false),
		),
		pagePort: Flag.integer("page-port").pipe(
			Flag.withDescription("Port for the page (default: a free one)"),
			Flag.withDefault(0),
		),
	},
	Effect.fn(function* ({config, project, noPage, pagePort}) {
		const {report, kernel} = yield* boot({
			global: Option.getOrElse(config, defaultGlobalConfig),
			project: Option.getOrElse(project, () => process.cwd()),
		}).pipe(
			Effect.catch((error) =>
				Console.error(`tuval: refusing to boot — ${error.message}`).pipe(
					Effect.andThen(Effect.fail(new BootRefused())),
				),
			),
		);
		const from = report.sources.length === 0 ? "no config module" : report.sources.join(" + ");
		yield* Console.log(
			`tuval: booted — ${report.programCount} program(s), ${report.spellCount} spell(s) registered from ${from}; ${report.processCount} process(es) live, ${report.restoredCount} restored from ${report.stateDir}`,
		);
		// A binding that did not compile costs its own key and nothing else, so this is a report and
		// not a refusal: boot goes on with the bindings that did compile.
		for (const line of renderBindingErrors(report.bindingErrors)) {
			yield* Console.log(`tuval: ${line}`);
		}
		const rows = yield* ProcessTablePort.use((port) => port.rows).pipe(
			Effect.provideContext(kernel),
		);
		for (const row of rows) yield* Console.log(renderRow(row));
		if (rows.length === 0) return;

		// The socket first: the page is handed its URL, so the transport has to be bound before the
		// dev server that will answer with it.
		const transport = yield* serveDesk({kernel, port: 0});
		yield* Console.log(`tuval: transport on 127.0.0.1:${transport.port}`);
		if (noPage) {
			yield* Console.log("tuval: no page served (--no-page)");
		} else {
			// A page that will not start does not take the kernel down with it: the processes are up
			// and checkpointing, and a second `pnpm dev` can attach to the same socket.
			yield* servePage({root: appRoot, launchUrl: transport.launchUrl, port: pagePort}).pipe(
				Effect.flatMap((page) => Console.log(`tuval: desk at ${page.url}`)),
				Effect.catch((error) => Console.error(`tuval: ${error.message}`)),
			);
		}
		yield* Console.log("tuval: running — Ctrl-C stops and checkpoints");
		return yield* Effect.never.pipe(Effect.onInterrupt(() => Console.log("tuval: stopping")));
	}, Effect.scoped),
).pipe(
	Command.withDescription("Boot Tuval's programs from your config and show the process table"),
);

tuval.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain({
		teardown: (exit, onExit) =>
			Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
				? onExit(0)
				: Runtime.defaultTeardown(exit, onExit),
	}),
);
