/**
 * `tuval` — the bin: one Effect CLI root command over the pure `boot` (#7548), and `tuval open`
 * beside it (#9696).
 *
 *   node src/bin.ts                         # start a desk, or bring the running one forward
 *   node src/bin.ts open <folder>           # add a project to the running desk, or start one with it
 *   node src/bin.ts --config <module>       # another global config module, for a new desk
 *   node src/bin.ts --project <dir>         # another first project (its .tuval/ config layer)
 *   node src/bin.ts --help
 *
 * Which of those happens is `decide`'s (`./discovery/decide.ts`), over the discovery record a
 * running desk leaves under the home `.tuval` and whether that desk still answers. A desk with no
 * page writes no record, since its page is how a caller reaches it.
 *
 * The desk's saved state is not in the project: it lives under `~/.tuval/projects/<key>`, keyed by
 * the project checkout's absolute path (ADR 0402). The boot line names the directory it used, and
 * a boot that found state left in a project by an older build says what it moved.
 *
 * Ctrl-C is `NodeRuntime.runMain`'s interrupt: it interrupts the main fiber, whose Scope closing
 * stops and checkpoints every process. That stop is the documented way out, so it exits 0 rather
 * than the runner's default 130.
 */

import {homedir} from "node:os";
import {dirname, resolve} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {renderBindingErrors} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
import {renderAdoption} from "@kampus/tuval-sdk/kernel/state-dir";
import {Cause, Console, Context, Effect, Exit, Layer, Option, Runtime, Stream} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {boot, defaultGlobalConfig} from "./boot.ts";
import {watchConfig} from "./config-watch.ts";
import {type DeskAction, type DeskRequest, decide} from "./discovery/decide.ts";
import {DeskWindow, openInDesk, renderOpenReply} from "./discovery/reach.ts";
import {advertiseDesk, removeDeskRecord} from "./discovery/record.ts";
import {DeskProbe, sightDesk} from "./discovery/sighting.ts";
import {servePage} from "./page/dev-server.ts";
import {displayHost} from "./page/loopback.ts";
import {Projects} from "./projects/Projects.ts";
import {serveDesk} from "./shell/host/index.ts";
import {ProcessTablePort} from "./table/ProcessTablePort.ts";
import type {TableRow} from "./table/row.ts";

/** The app's own directory — `index.html`'s home, and so the page server's root. */
const appRoot = dirname(import.meta.dirname);

/**
 * The operator's own home dir. Every other boot names a scratch one, which is why
 * `BootOptions.home` is required rather than defaulted.
 */
const home = homedir();

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

/** The flags a new desk boots with. A running desk keeps the ones it was started with. */
interface DeskFlags {
	readonly config: Option.Option<string>;
	readonly noPage: boolean;
	readonly pagePort: number;
}

/** Boot a desk with `project` as its first project, and run it until Ctrl-C. */
const runDesk = Effect.fn("Tuval.runDesk")(function* (flags: DeskFlags, project: string) {
	const {report, kernel, keyTable, moduleRenderers, features, files, reload} = yield* boot({
		global: Option.getOrElse(flags.config, defaultGlobalConfig),
		project,
		home,
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
	// The one-time move of state an older build left in the project (ADR 0402 rule 7).
	// `renderAdoption` owns which lines a given adoption earns.
	for (const line of renderAdoption(report.adopted, report.stateDir)) {
		yield* Console.log(`tuval: ${line}`);
	}
	// The one-time move of checkpoints onto project-scoped ids (#9684), said once, on the boot that ran it.
	if (report.scoped.moved.length > 0) {
		yield* Console.log(
			`tuval: moved ${report.scoped.moved.length} checkpoint(s) onto project-scoped ids in ${report.stateDir}`,
		);
	}
	// A binding that did not compile costs its own key and nothing else, so this is a report and
	// not a refusal: boot goes on with the bindings that did compile.
	for (const line of renderBindingErrors(report.bindingErrors)) {
		yield* Console.log(`tuval: ${line}`);
	}
	// A program outside its SDK range costs that program and nothing else (#9686).
	for (const refusal of report.refused) yield* Console.log(`tuval: ${refusal.message}`);
	// The projects that were open when the desk last stopped (#9688). A folder that is gone or no
	// longer trusted costs that folder and nothing else.
	for (const folder of report.reopened) yield* Console.log(`tuval: reopened the project ${folder}`);
	for (const skip of report.skipped) yield* Console.log(`tuval: ${skip.message}`);
	const rows = yield* ProcessTablePort.use((port) => port.rows).pipe(Effect.provideContext(kernel));
	for (const row of rows) yield* Console.log(renderRow(row));
	if (rows.length === 0) return;

	// The socket first: the page is handed its URL, so the transport has to be bound before the
	// dev server that will answer with it.
	const transport = yield* serveDesk({kernel, port: 0, table: keyTable});
	yield* Console.log(`tuval: transport on 127.0.0.1:${transport.port}`);
	const projects = Context.get(kernel, Projects);
	// Opening or closing a project adds or removes registry rows, and a page's picker lists them.
	yield* projects.changes.pipe(
		Stream.drop(1),
		Stream.runForEach(() => transport.publishRegistry),
		Effect.forkScoped,
	);
	if (flags.noPage) {
		yield* Console.log("tuval: no page served (--no-page)");
	} else {
		// A page that will not start does not take the kernel down with it: the processes are up
		// and checkpointing, and a second `pnpm dev` can attach to the same socket.
		// `servePage` admits its own port with the transport's fence before returning, so the URL
		// printed here is one a browser can actually attach from (#7560).
		// The config's rows are the page's loader list too: every `kind: "module"` renderer they name
		// is handed to the page server beside the config module that declared it, and the page refuses
		// a specifier that resolves from neither (ADR 0359, amended by #8262).
		// The merged flags ride along for the same reason the rows do: the page generates them into
		// a module its renderer table imports, and that is the only way a flag an operator turned
		// on in their config reaches the browser (#8439).
		// A project opened into the running desk brings its renderers with it (#9685).
		yield* servePage({
			root: appRoot,
			transport,
			port: flags.pagePort,
			moduleRenderers,
			moduleRendererChanges: projects.renderers,
			features,
		}).pipe(
			Effect.tap((page) =>
				// The localhost URL, and the addresses behind it: whichever family the browser resolves
				// reaches this desk, and the founder can see that it does (ADR 0370, #8593).
				Console.log(`tuval: desk at ${page.url} — ${page.hosts.map(displayHost).join(" and ")}`),
			),
			// Another `tuval` finds this desk through its record for as long as the desk runs. A record
			// that cannot be written costs that and nothing else.
			Effect.flatMap((page) =>
				advertiseDesk(home, page.url).pipe(
					Effect.catch((error) =>
						Console.error(
							`tuval: another tuval command will not find this desk — ${error.message}`,
						),
					),
				),
			),
			Effect.catch((error) => Console.error(`tuval: ${error.message}`)),
		);
	}
	// Saving the config, or a program file it imports, reloads the desk. A watch that fails costs
	// the hot reload and nothing else: `config:reload` still reads the config on demand.
	yield* watchConfig({files, reload}).pipe(
		Effect.catch((error) => Console.error(`tuval: stopped watching the config — ${error.message}`)),
		Effect.forkScoped,
	);
	yield* Console.log("tuval: running — Ctrl-C stops and checkpoints");
	return yield* Effect.never.pipe(Effect.onInterrupt(() => Console.log("tuval: stopping")));
}, Effect.scoped);

/** A page that cannot be brought forward is said, with its address, and the command goes on. */
const bringForward = (page: string) =>
	DeskWindow.use((window) => window.show(page)).pipe(
		Effect.catch((error) => Console.error(`tuval: ${error.message} — open ${page} yourself`)),
	);

/** Do what `decide` chose. */
const act = Effect.fn("Tuval.act")(function* (flags: DeskFlags, action: DeskAction) {
	switch (action._tag) {
		case "Start":
			if (action.stale !== null) {
				yield* Console.log(
					`tuval: replacing the record of a desk that is gone — ${action.stale.reason}`,
				);
				yield* Effect.ignore(removeDeskRecord(home, action.stale.pid));
			}
			return yield* runDesk(flags, action.project);
		case "Forward":
			if (action.startFlagsIgnored) {
				yield* Console.log(
					"tuval: --config, --project, --no-page and --page-port shape a new desk; the running one keeps its own",
				);
			}
			yield* Console.log(
				`tuval: a desk is already running (pid ${action.desk.pid}) — bringing ${action.desk.page} forward`,
			);
			return yield* bringForward(action.desk.page);
		case "OpenIn": {
			// Forward first: an open of an untrusted folder waits on the question that page asks.
			yield* bringForward(action.desk.page);
			yield* Console.log(`tuval: asking the running desk to open ${action.folder}`);
			const reply = yield* openInDesk(action.launchUrl, action.folder).pipe(
				Effect.catch((error) =>
					Console.error(`tuval: ${error.message}`).pipe(
						Effect.andThen(Effect.fail(new BootRefused())),
					),
				),
			);
			const {opened, lines} = renderOpenReply(action.folder, reply);
			for (const line of lines) yield* opened ? Console.log(line) : Console.error(line);
			if (!opened) return yield* Effect.fail(new BootRefused());
			return;
		}
	}
});

/** Find the desk running under this home, decide, and act. */
const run = (flags: DeskFlags, request: DeskRequest) =>
	Effect.gen(function* () {
		return yield* act(flags, decide(request, yield* sightDesk(home)));
	}).pipe(Effect.provide(Layer.mergeAll(DeskProbe.layer, DeskWindow.browser)));

const tuvalRoot = Command.make("tuval", {
	project: Flag.directory("project", {mustExist: true}).pipe(
		Flag.withDescription("Project dir whose .tuval/ holds the project config (default: cwd)"),
		Flag.optional,
	),
}).pipe(
	Command.withSharedFlags({
		config: Flag.file("config", {mustExist: true}).pipe(
			Flag.withDescription(
				"Global config module for a new desk (default: ~/.tuval/tuval.config.ts)",
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
	}),
	Command.withHandler(({config, project, noPage, pagePort}) =>
		run(
			{config, noPage, pagePort},
			{
				_tag: "Show",
				project: resolve(Option.getOrElse(project, () => process.cwd())),
				startFlags: Option.isSome(config) || Option.isSome(project) || noPage || pagePort !== 0,
			},
		),
	),
	Command.withDescription("Start a Tuval desk, or bring the running one forward"),
);

const open = Command.make(
	"open",
	{folder: Argument.directory("folder", {mustExist: true})},
	Effect.fn(function* ({folder}) {
		const {config, noPage, pagePort} = yield* tuvalRoot;
		return yield* run({config, noPage, pagePort}, {_tag: "Open", folder: resolve(folder)});
	}),
).pipe(
	Command.withDescription("Add a folder as a project to the running desk, or start a desk with it"),
);

tuvalRoot.pipe(
	Command.withSubcommands([open]),
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain({
		teardown: (exit, onExit) =>
			Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
				? onExit(0)
				: Runtime.defaultTeardown(exit, onExit),
	}),
);
