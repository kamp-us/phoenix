/**
 * Prove an outside author can run and hot-reload a program on the packed desk (#9690). It packs
 * `@kampus/tuval-sdk` and `@kampus/tuval`, installs both with npm into a folder outside the checkout,
 * writes a program there and adds it to that folder's `.tuval/tuval.config.ts`, and runs the author
 * loop against a scratch home:
 *
 * 1. `tuval open .` starts a desk with the folder as its first project, and the program runs.
 * 2. `tuval open` of a second folder asks the running desk's "Trust this folder?", which is
 *    answered over the desk's own transport as its page would answer it, and that folder's program
 *    runs too.
 * 3. The program file is edited, the desk reloads it, and the running process shows the edited code
 *    over the state it already had, with no desk restart.
 *
 * Every process the desk starts logs the modules it resolved, and the run fails if any of them lies
 * inside the checkout or if more than one SDK copy was loaded. The judging lives in `outside.ts`.
 *
 * Every wait is bounded and says what it was waiting for (`.patterns/ci-legible-integration-tests.md`).
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import type {ProcessView} from "@kampus/tuval-sdk/kernel/shell/window/host";
import {Duration, Effect, Option, Schema, type Scope, Stream, SubscriptionRef} from "effect";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";
import {Socket} from "effect/unstable/socket";
import {ProjectId} from "../project-id.ts";
import {attach} from "../shell/transport/client.ts";
import type {TableRow} from "../table/row.ts";
import {BIN_NAME, SDK_PACKAGE} from "./manifest.ts";
import {effectPin, judge, packedDeskFindings, placement, render, resolvedFiles} from "./outside.ts";

const PROOF_DIR = import.meta.dirname;
const APP = resolve(PROOF_DIR, "../..");
const SDK_DIR = realpathSync(join(APP, "node_modules", SDK_PACKAGE));
const CHECKOUT = realpathSync(resolve(APP, "../.."));

/** A cold npm install of the desk's dependencies, and a first page prebundle, both fit well inside. */
const DESK_UP = Duration.minutes(4);
const STEP = Duration.seconds(60);

class ProofFailed extends Schema.TaggedError<ProofFailed>()("tuval/publish/ProofFailed", {
	message: Schema.String,
}) {}

/** The environment every step runs under: nothing a `pnpm run` in the checkout sets reaches it. */
const outsideEnv = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "TMPDIR", "CI"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return {...env, ...extra};
};

interface Run {
	readonly file: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	/** Absent: inherit the checkout's environment. Present: exactly this environment. */
	readonly env?: Record<string, string>;
	/** Capture stdout for the caller instead of streaming it to the log. */
	readonly capture?: boolean;
}

const command = (r: Run) =>
	ChildProcess.make(r.file, [...r.args], {
		cwd: r.cwd,
		...(r.env === undefined ? {} : {env: r.env, extendEnv: false}),
		detached: false,
		stdin: "ignore",
		stdout: r.capture === true ? "pipe" : "inherit",
		stderr: "inherit",
	});

/** A failure that is not already the proof's own is the platform refusing to run `step`. */
const couldNotRun =
	(step: string) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, ProofFailed, R> =>
		Effect.mapError(self, (error) =>
			error instanceof ProofFailed
				? error
				: new ProofFailed({
						message: `${step} could not run: ${error instanceof Error ? error.message : String(error)}`,
					}),
		);

/** Run one step to its end; a non-zero exit fails the proof, naming the step. */
const run = (step: string, r: Run) =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* Effect.logInfo(`desk outside proof: ${step}`);
			const handle = yield* command(r);
			const stdout =
				r.capture === true ? yield* Stream.mkString(Stream.decodeText(handle.stdout)) : "";
			const code = yield* handle.exitCode;
			if (code !== 0) {
				if (stdout !== "") process.stderr.write(stdout);
				return yield* new ProofFailed({message: `${step} exited ${code}`});
			}
			return stdout;
		}),
	).pipe(couldNotRun(step));

/** A long-running `tuval`: its stdout lines, echoed to the log as they arrive, and its handle. */
const startTuval = (
	name: string,
	r: Run,
): Effect.Effect<
	{
		readonly lines: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>;
		readonly handle: ChildProcessSpawner.ChildProcessHandle;
	},
	ProofFailed,
	Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		yield* Effect.logInfo(`desk outside proof: start ${name}`);
		const handle = yield* ChildProcess.make(r.file, [...r.args], {
			cwd: r.cwd,
			...(r.env === undefined ? {} : {env: r.env, extendEnv: false}),
			detached: false,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "inherit",
		});
		const lines = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
		yield* handle.stdout.pipe(
			Stream.decodeText,
			Stream.splitLines,
			Stream.runForEach((line) =>
				Effect.andThen(
					Effect.sync(() => process.stderr.write(`[${name}] ${line}\n`)),
					SubscriptionRef.update(lines, (seen) => [...seen, line]),
				),
			),
			Effect.ignore,
			Effect.forkScoped,
		);
		return {lines, handle};
	}).pipe(couldNotRun(`start ${name}`));

/** The first value of `stream` that `pick` accepts, or a failure naming `what` after `within`. */
const awaitValue = <A, B>(
	what: string,
	stream: Stream.Stream<A, unknown>,
	pick: (value: A) => B | undefined,
	within: Duration.Input = STEP,
) =>
	stream.pipe(
		Stream.map(pick),
		Stream.filter((value): value is B => value !== undefined),
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(new ProofFailed({message: `ended before ${what}`})),
				onSome: (value: B) => Effect.succeed(value),
			}),
		),
		Effect.catchCause((cause) =>
			Effect.fail(
				cause.reasons.some(
					(reason) => reason._tag === "Fail" && reason.error instanceof ProofFailed,
				)
					? new ProofFailed({message: `ended before ${what}`})
					: new ProofFailed({message: `failed waiting for ${what}: ${String(cause)}`}),
			),
		),
		Effect.timeoutOrElse({
			duration: within,
			orElse: () => Effect.fail(new ProofFailed({message: `timed out waiting for ${what}`})),
		}),
	);

const awaitLine = (
	what: string,
	lines: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>,
	pattern: RegExp,
	within?: Duration.Input,
) =>
	awaitValue(
		what,
		SubscriptionRef.changes(lines),
		(seen) => seen.map((line) => pattern.exec(line)).find((match) => match !== null) ?? undefined,
		within,
	);

const titleOf = (row: TableRow): string | undefined => Option.getOrUndefined(row.title);

const fetchText = (what: string, url: string) =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.text();
		},
		catch: (error) => new ProofFailed({message: `${what} (${url}) did not load: ${String(error)}`}),
	});

/**
 * The program the author edits, written against the SDK's authoring API as the README tells an
 * author to write one: a count it keeps, stamped with the edit that last counted, and a title that
 * names the edit too. Its `update` and `title` run only behind the SDK's compiled closures, so the
 * reload switching it is what proves the desk reads the author's own code (#9679 criterion 16).
 */
interface GreeterState {
	readonly pokes: number;
	readonly by: string;
}

const greeterSource = (
	edit: string,
): string => `import {defineProgram, program} from "@kampus/tuval-sdk/authoring";

type Greeter = {readonly pokes: number; readonly by: string};

export const greeter = defineProgram(
	program({
		id: "greeter",
		ports: {},
		init: (): Greeter => ({pokes: 0, by: "${edit}"}),
		update: {
			poke: (state: Greeter) => [{pokes: state.pokes + 1, by: "${edit}"}, []] as const,
		},
		title: (state: Greeter) => \`greeter ${edit} \${state.pokes}\`,
	}),
);
`;

/** The second folder's program, written against the SDK's authoring API. */
const helloSource = `import {defineProgram, program} from "@kampus/tuval-sdk/authoring";

export const hello = program({
	id: "hello",
	ports: {},
	init: () => ({}),
	update: {},
	title: () => "hello from the second folder",
});

export const helloRow = defineProgram(hello);
`;

const configSource = (
	from: string,
	row: string,
	node: string,
): string => `import {${row}} from "${from}";

export default {
	version: 1,
	programs: [${row}],
	graph: {nodes: [{id: "${node}", program: "${node}", on: []}]},
};
`;

/** Stand-ins for the platform's URL opener, so bringing the desk forward opens no browser here. */
const OPENERS = ["open", "xdg-open"];

/** The whole loop in `work`; a failure is kept there for whoever reads the log. */
const authorLoop = (work: string) =>
	Effect.gen(function* () {
		const dirs = {
			pack: join(work, "pack"),
			author: join(work, "author"),
			second: join(work, "second"),
			home: join(work, "home"),
			bin: join(work, "bin"),
		};
		for (const dir of Object.values(dirs)) mkdirSync(dir, {recursive: true});

		const pack = (what: string, cwd: string) =>
			run(`pnpm pack ${what}`, {
				file: "pnpm",
				args: ["pack", "--pack-destination", dirs.pack],
				cwd,
				capture: true,
			}).pipe(
				Effect.map((stdout) => stdout.trim().split("\n").at(-1)?.trim() ?? ""),
				Effect.filterOrFail(
					(tarball) => tarball.endsWith(".tgz") && existsSync(tarball),
					() => new ProofFailed({message: `pnpm pack ${what} named no tarball`}),
				),
			);
		const sdkTarball = yield* pack(SDK_PACKAGE, SDK_DIR);
		const deskTarball = yield* pack("the desk", APP);

		const packedJson = (tarball: string) =>
			run("read a packed manifest", {
				file: "tar",
				args: ["-xzOf", tarball, "package/package.json"],
				cwd: work,
				capture: true,
			});
		const entries = (yield* run("list the packed desk", {
			file: "tar",
			args: ["-tzf", deskTarball],
			cwd: work,
			capture: true,
		}))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		const findings = packedDeskFindings(yield* packedJson(deskTarball), entries);
		if (findings.length > 0) {
			return yield* new ProofFailed({message: `the packed desk:\n  ${findings.join("\n  ")}`});
		}
		const sdkManifest = yield* packedJson(sdkTarball);
		const effect = yield* Effect.try({
			try: () => effectPin(sdkManifest),
			catch: (error) => new ProofFailed({message: String(error)}),
		});

		writeFileSync(
			join(dirs.author, "package.json"),
			`${JSON.stringify({name: "outside-author", private: true, type: "module"}, null, "\t")}\n`,
		);
		yield* run("npm install", {
			file: "npm",
			args: [
				"install",
				"--no-audit",
				"--no-fund",
				"--save-exact",
				sdkTarball,
				deskTarball,
				`effect@${effect}`,
			],
			cwd: dirs.author,
			env: outsideEnv(),
		});

		const greeterFile = join(dirs.author, "greeter.ts");
		writeFileSync(greeterFile, greeterSource("first"));
		writeFileSync(join(dirs.author, "hello.ts"), helloSource);
		mkdirSync(join(dirs.author, ".tuval"));
		writeFileSync(
			join(dirs.author, ".tuval", "tuval.config.ts"),
			configSource("../greeter.ts", "greeter", "greeter"),
		);
		mkdirSync(join(dirs.second, ".tuval"));
		writeFileSync(
			join(dirs.second, ".tuval", "tuval.config.ts"),
			configSource("../../author/hello.ts", "helloRow", "hello"),
		);
		for (const opener of OPENERS) {
			writeFileSync(join(dirs.bin, opener), "#!/bin/sh\nexit 0\n", {mode: 0o755});
		}

		const hook = join(work, "resolve-log.mjs");
		const log = join(work, "resolved.log");
		cpSync(join(PROOF_DIR, "resolve-log.mjs"), hook);
		writeFileSync(log, "");
		const tuvalEnv = outsideEnv({
			PATH: `${dirs.bin}:${process.env.PATH ?? ""}`,
			HOME: dirs.home,
			NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
			TUVAL_RESOLVE_LOG: log,
		});
		const tuval = join(dirs.author, "node_modules", ".bin", BIN_NAME);

		yield* Effect.scoped(
			Effect.gen(function* () {
				const desk = yield* startTuval("tuval open .", {
					file: tuval,
					args: ["open", "."],
					cwd: dirs.author,
					env: tuvalEnv,
				});
				const [, page] = yield* awaitLine(
					"the desk to serve its page",
					desk.lines,
					/^tuval: desk at (\S+) /,
					DESK_UP,
				);
				if (page === undefined) return yield* new ProofFailed({message: "the desk named no page"});

				const html = yield* fetchText("the desk's page", page);
				const entry = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
				if (!html.includes('id="tuval"') || entry === undefined) {
					return yield* new ProofFailed({
						message: `the desk's page is not the packed page:\n${html}`,
					});
				}
				yield* fetchText("the page's entry module", new URL(entry, page).href);
				const launch = Schema.decodeUnknownSync(Schema.Struct({url: Schema.String}))(
					JSON.parse(yield* fetchText("the launch URL", new URL("/__tuval/launch", page).href)),
				);
				const attached = yield* attach(launch.url).pipe(
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.mapError(
						(error) => new ProofFailed({message: `could not attach to the desk: ${String(error)}`}),
					),
				);

				// "Trust this folder?" is answered yes for the proof's own folders, the way a person at
				// the page answers it, whichever open asks.
				const proofFolders = new Set([dirs.author, dirs.second]);
				const trusted = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
				yield* attached.trustPrompts.pipe(
					Stream.flatMap((prompts) => Stream.fromIterable(prompts)),
					Stream.filter((prompt) => proofFolders.has(prompt.folder)),
					Stream.runForEach((prompt) =>
						Effect.andThen(
							attached.answerTrust(prompt.question, "trust"),
							SubscriptionRef.update(trusted, (folders) => [...folders, prompt.folder]),
						),
					),
					Effect.forkScoped,
				);

				const rowOf = (folder: string, node: string) => {
					const id = ProcessId.make(ProjectId.of(folder).scope(node));
					return (rows: ReadonlyArray<TableRow>) => rows.find((row) => row.id === id);
				};

				// What the desk shows of the author's process is its state, pushed to the page over this
				// socket on every commit.
				const running = yield* awaitValue(
					"the author's program to run",
					attached.rows,
					rowOf(dirs.author, "greeter"),
				);
				const greeter = yield* attached
					.attachProcess<GreeterState>(running.id)
					.pipe(
						Effect.mapError(
							(error) =>
								new ProofFailed({message: `could not attach to the program: ${String(error)}`}),
						),
					);
				const shows = (pokes: number, by: string) => (view: ProcessView<GreeterState>) =>
					view._tag === "Live" && view.state.pokes === pokes && view.state.by === by
						? view
						: undefined;
				yield* awaitValue("the program's first state", greeter.readProcess, shows(0, "first"));
				yield* greeter.dispatch({type: "poke"});
				yield* awaitValue("the program to count a poke", greeter.readProcess, shows(1, "first"));

				const opening = yield* startTuval("tuval open <second folder>", {
					file: tuval,
					args: ["open", dirs.second],
					cwd: dirs.second,
					env: tuvalEnv,
				});
				yield* awaitValue(
					"the running desk to ask whether to trust the second folder",
					SubscriptionRef.changes(trusted),
					(folders) => (folders.includes(dirs.second) ? true : undefined),
				);
				const opened = yield* opening.handle.exitCode.pipe(
					couldNotRun("tuval open <second folder>"),
				);
				if (opened !== 0) {
					return yield* new ProofFailed({message: `tuval open <second folder> exited ${opened}`});
				}
				yield* awaitValue("the second folder's program to run", attached.rows, (rows) => {
					const row = rowOf(dirs.second, "hello")(rows);
					return row !== undefined && titleOf(row) === "hello from the second folder"
						? row
						: undefined;
				});

				const before = (yield* SubscriptionRef.get(desk.lines)).length;
				writeFileSync(greeterFile, greeterSource("edited"));
				yield* awaitValue(
					"the desk to reload the edited program onto its running process",
					SubscriptionRef.changes(desk.lines),
					(seen) =>
						seen
							.slice(before)
							.find(
								(line) =>
									line.startsWith("tuval: config reloaded") &&
									line.includes(`switched: ${running.id}`),
							),
				);
				yield* greeter.dispatch({type: "poke"});
				yield* awaitValue(
					"the running process to show the edit over the count it kept",
					greeter.readProcess,
					shows(2, "edited"),
				);
				yield* awaitValue("the desk to show the program's edited title", attached.rows, (rows) => {
					const row = rowOf(dirs.author, "greeter")(rows);
					return row !== undefined && titleOf(row) === "greeter edited 2" ? row : undefined;
				});
				const boots = (yield* SubscriptionRef.get(desk.lines)).filter((line) =>
					line.startsWith("tuval: booted"),
				);
				if (boots.length !== 1 || !(yield* desk.handle.isRunning.pipe(couldNotRun("the desk")))) {
					return yield* new ProofFailed({message: "the desk restarted to show the edit"});
				}

				yield* desk.handle
					.kill({killSignal: "SIGINT", forceKillAfter: STEP})
					.pipe(couldNotRun("stop the desk"));
				const stopped = yield* desk.handle.exitCode.pipe(couldNotRun("the desk"));
				if (stopped !== 0)
					return yield* new ProofFailed({message: `the desk exited ${stopped} on Ctrl-C`});
			}),
		);

		const verdict = judge(
			CHECKOUT,
			resolvedFiles(readFileSync(log, "utf8")).map((path) =>
				existsSync(path) ? realpathSync(path) : path,
			),
		);
		if (verdict._tag !== "Clean") return yield* new ProofFailed({message: render(verdict)});
		yield* Effect.logInfo(render(verdict));
	}).pipe(Effect.mapError((error) => new ProofFailed({message: `${error.message}\nkept ${work}`})));

const proof = Effect.gen(function* () {
	const work = realpathSync(mkdtempSync(join(tmpdir(), "tuval-desk-outside-")));
	const where = placement(CHECKOUT, work);
	if (where._tag === "Inside") {
		return yield* new ProofFailed({
			message: `the temporary directory ${where.path} lies inside the checkout`,
		});
	}
	yield* authorLoop(work);
	rmSync(work, {recursive: true, force: true});
});

proof.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
