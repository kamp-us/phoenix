/**
 * Provisioning, as an Effect program: a sequence of declared inputs resolved in a fixed order, over
 * one service, with one tagged error per step.
 *
 * **The order is the contract.** worktree → port → env → setup, and never another. Each step needs
 * what the one before it produced: the `.env` is written *into* the worktree, so the directory has
 * to exist; the port goes *into* the `.env`, so it has to be picked first; `setup` runs *in* the
 * worktree with `$PORT` already substituted. `Effect.gen` states that order as the statements it
 * is — a step that fails short-circuits the rest by construction rather than by an `if` a reader
 * has to check — and a test still asserts it as a list of recorded commands, because a reordering
 * here is silent and expensive.
 *
 * **A failure names its step by type.** There is no `step: string` field anybody could set wrong:
 * the ways a provision stops are `Data.TaggedError` classes, and the word a record shows is read
 * off the `_tag` through an exhaustive map. An error that carries no step, or a step no error
 * produces, does not typecheck.
 *
 * **The compensation records, it does not delete.** The worktree is acquired with
 * `Effect.acquireRelease`, and its release on a failed scope writes the path down as *kept* rather
 * than removing it. That is deliberate and is the documented rule: rolling back would delete the
 * one piece of evidence about what went wrong, and a half-built tree is still removable by
 * `:workspace close <name>` when a person asks. The `kept` path on a failed outcome is that rule,
 * as a value a test can assert on instead of a paragraph.
 *
 * **The machine is a service.** Everything that touches git, a socket or the disk goes through
 * `Machine`, whose shape is `./runner.ts`'s `Runner`. `MachineLive` is the real one; a test hands
 * `machineLayer(fakeRunner())` instead, so the suite for this package never runs git, never binds a
 * port and never writes a file outside a fake.
 *
 * **Nothing in this module knows where it is run from, and that is the point.** `provision`,
 * `teardown` and `reconcile` are values: an `Effect` requiring `Machine`, answering with an
 * outcome, dispatching nothing. That is the shape an effect handler takes, and that is where they
 * are run from — `./workspace.ts` spreads one handler per entry point onto its compiled row
 * (kamp-us/phoenix#8716 R12.1, shipped as #9295) and provides the `Machine` layer there.
 */

import {join} from "node:path";
import {Context, Data, Effect, Exit, Layer, Ref, type Scope} from "effect";
import {nodeRunner, type Runner} from "./runner.ts";

// -- The machine, as a service ----------------------------------------------

/**
 * Everything this package asks of the world, as one Effect service. The shape is `Runner` — the
 * same five Promise-returning methods a consumer already implements — so the injection point stays
 * one interface and this class is only how the program reaches it.
 */
export class Machine extends Context.Service<Machine, Runner>()(
	"@kampus/tuval-workspace/Machine",
) {}

/** The real machine. What a desk runs under. */
export const MachineLive: Layer.Layer<Machine> = Layer.sync(Machine, nodeRunner);

/** Any `Runner` as a layer — how a test hands the recording fake in, and how a config's own does. */
export const machineLayer = (runner: Runner): Layer.Layer<Machine> =>
	Layer.succeed(Machine, runner);

/** One `Runner` call, as an Effect. A `Runner` never throws by contract, so this never fails. */
const ask = <A>(call: (runner: Runner) => Promise<A>): Effect.Effect<A, never, Machine> =>
	// biome-ignore lint/plugin: `Runner` never rejects by contract — every method answers with a result object and the two implementations (`src/runner.ts`, `src/fake-runner.ts`) are the whole set. There is no rejection here to become a defect.
	Machine.use((runner) => Effect.promise(() => call(runner)));

// -- Substitution -----------------------------------------------------------

/**
 * The four substitutions a `setup` line, a `teardown` line and an env value may use. They are
 * resolved by this package *before* the shell sees the command.
 *
 * **The worktree is `$WORKTREE`, and it used to be `$PATH`.** It was renamed because this
 * substitution runs over the raw command line: `PATH=$PATH:./bin` in a setup command meant the
 * worktree, not the shell's executable search path, and the shell never saw a `$PATH` to expand.
 * `$WORKTREE` collides with nothing a shell already owns, so there is no escape hatch here any
 * more — `$$` is left alone for the shell, where it is the process id.
 */
export interface Vars {
	/** What the person called the workspace. */
	readonly NAME: string;
	/** The port the probe found, as a string. */
	readonly PORT: string;
	/** The worktree directory, absolute. */
	readonly WORKTREE: string;
	/** The branch the worktree is on. */
	readonly BRANCH: string;
}

const VARIABLE = /\$\{(NAME|PORT|WORKTREE|BRANCH)\}|\$(NAME|PORT|WORKTREE|BRANCH)\b/g;

/** One string with its variables resolved. Pure, total, and the only substitution in the package. */
export const substitute = (text: string, vars: Vars): string =>
	text.replace(VARIABLE, (_match, braced?: string, bare?: string) => {
		const name = (braced ?? bare) as keyof Vars;
		return vars[name];
	});

// -- What a failure is allowed to carry -------------------------------------

/**
 * How much of a command's output a failure detail may carry. Bounded because the detail is
 * checkpointed with the rest of the state: an unbounded `pnpm install` stack trace would be
 * written to disk on every save, for ever.
 */
export const DETAIL_LIMIT = 500;

/**
 * A failing command's output, made safe to keep. Two rules, and neither one is a promise that the
 * output is now secret-free — they cover the two shapes a secret takes in build output often
 * enough to be worth doing, and a command that prints a bare token still prints a bare token:
 *
 *  - a URL with credentials in it — `https://user:pw@host` becomes `https://***:***@host`, which is
 *    the shape a failing `git clone`, `npm` or `psql` prints back at you;
 *  - a `KEY=value` assignment whose key contains `SECRET`, `TOKEN` or `PASSWORD` in any case —
 *    the value becomes `***`, the key is kept, because which variable it was is the useful half.
 *
 * Then the whole thing is cut to `DETAIL_LIMIT` with the cut named, so a person reading a truncated
 * detail knows there was more rather than wondering why the error stops mid-word.
 *
 * It is applied once, at the boundary where an error becomes an outcome — the errors themselves
 * carry the raw output, because an error is a fact and this is a rendering of one.
 */
export const safeDetail = (text: string): string => {
	const redacted = text
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]*)@/gi, "$1***:***@")
		.replace(
			// The value runs to the first whitespace or closing punctuation, so a token quoted inside
			// `(NPM_TOKEN=abc)` loses the token and keeps the bracket the reader needs.
			/\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)\s*=\s*[^\s,;)\]}"']+/gi,
			"$1=***",
		);
	return redacted.length <= DETAIL_LIMIT
		? redacted
		: `${redacted.slice(0, DETAIL_LIMIT)}… (truncated)`;
};

// -- The env file -----------------------------------------------------------

/**
 * The env file, rewritten. Every assignment either replaces the first uncommented line that sets
 * that key or is appended at the end; nothing else in the template moves, so the comments a person
 * wrote in `.env.example` survive into every workspace's `.env`.
 *
 * A commented-out `# PORT=3000` is left commented and the real assignment is appended below it —
 * uncommenting someone's example line is a guess, and appending is not.
 */
export const rewriteEnv = (
	template: string,
	assignments: ReadonlyArray<readonly [string, string]>,
): string => {
	let lines = template.split("\n");
	const appended: string[] = [];
	for (const [key, value] of assignments) {
		const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
		const at = lines.findIndex((line) => pattern.test(line));
		if (at === -1) appended.push(`${key}=${value}`);
		else lines = lines.map((line, index) => (index === at ? `${key}=${value}` : line));
	}
	if (appended.length === 0) return lines.join("\n");
	const body = lines.join("\n");
	return `${body}${body.endsWith("\n") ? "" : "\n"}${appended.join("\n")}\n`;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The env half of a plan: which template, which key takes the port, what else to write. */
export interface EnvPlan {
	/** Relative to the repository root — `.env.example` unless a config says otherwise. */
	readonly template: string;
	/** The key the chosen port is written to. */
	readonly portKey: string;
	/** Anything else, with `$NAME`/`$PORT`/`$WORKTREE`/`$BRANCH` resolved before it is written. */
	readonly vars: Readonly<Record<string, string>>;
	/** What the written file is called, inside the worktree. */
	readonly file: string;
}

// -- The ways a provision stops ---------------------------------------------

/** `git worktree add` refused. Nothing was built, so there is nothing to keep. */
// biome-ignore lint/plugin: this package publishes to npm and its errors cross into a user's `tuval.config.ts`, not phoenix's fate wire — there is no `FateWireCode` for the annotation to carry, and the move keeps the error surface it arrived with (#9406).
export class WorktreeFailed extends Data.TaggedError("WorktreeFailed")<{
	readonly output: string;
}> {}

/** Every port in the declared range is spoken for, by the OS or by this program. */
// biome-ignore lint/plugin: this package publishes to npm and its errors cross into a user's `tuval.config.ts`, not phoenix's fate wire — there is no `FateWireCode` for the annotation to carry, and the move keeps the error surface it arrived with (#9406).
export class NoFreePort extends Data.TaggedError("NoFreePort")<{
	readonly from: number;
	readonly to: number;
}> {}

/** The env template is not where the config said it was. */
// biome-ignore lint/plugin: this package publishes to npm and its errors cross into a user's `tuval.config.ts`, not phoenix's fate wire — there is no `FateWireCode` for the annotation to carry, and the move keeps the error surface it arrived with (#9406).
export class EnvTemplateMissing extends Data.TaggedError("EnvTemplateMissing")<{
	readonly template: string;
}> {}

/**
 * The `.env` could not be written into the worktree — a read-only tree, a full disk, a directory
 * that went away underneath. It is a failure and not a defect on purpose: see `./runner.ts`'s
 * `WriteResult` for what a throwing write costs.
 */
// biome-ignore lint/plugin: this package publishes to npm and its errors cross into a user's `tuval.config.ts`, not phoenix's fate wire — there is no `FateWireCode` for the annotation to carry, and the move keeps the error surface it arrived with (#9406).
export class EnvWriteFailed extends Data.TaggedError("EnvWriteFailed")<{
	readonly file: string;
	readonly detail: string;
}> {}

/** A `setup` command the config wrote failed. The first failure wins and the rest never run. */
// biome-ignore lint/plugin: this package publishes to npm and its errors cross into a user's `tuval.config.ts`, not phoenix's fate wire — there is no `FateWireCode` for the annotation to carry, and the move keeps the error surface it arrived with (#9406).
export class SetupFailed extends Data.TaggedError("SetupFailed")<{
	readonly command: string;
	readonly output: string;
}> {}

export type ProvisionError =
	| WorktreeFailed
	| NoFreePort
	| EnvTemplateMissing
	| EnvWriteFailed
	| SetupFailed;

/** Which of the four steps a provision stopped on. The word a failed record shows. */
export type ProvisionStep = "worktree" | "port" | "env" | "setup";

/**
 * The step each failure *is*. Exhaustive over the `_tag`s by its type, so one more error class
 * fails to compile here rather than reaching a record as `undefined`. Two tags share the `env`
 * step, which is the point of the map: the step is the word a person reads, the tag is what the
 * program branches on.
 */
const STEP_OF: Readonly<Record<ProvisionError["_tag"], ProvisionStep>> = {
	WorktreeFailed: "worktree",
	NoFreePort: "port",
	EnvTemplateMissing: "env",
	EnvWriteFailed: "env",
	SetupFailed: "setup",
};

/** The sentence each failure shows, redacted and bounded at this one boundary. */
const detailOf = (error: ProvisionError): string => {
	switch (error._tag) {
		case "WorktreeFailed":
			return safeDetail(error.output);
		case "NoFreePort":
			return `no free port in ${error.from}-${error.to}`;
		case "EnvTemplateMissing":
			return `no env template at ${error.template}`;
		case "EnvWriteFailed":
			return safeDetail(`could not write ${error.file}: ${error.detail}`);
		case "SetupFailed":
			return safeDetail(`${error.command}: ${error.output}`);
	}
};

/** Everything one `open` needs, with nothing left to decide. */
export interface ProvisionPlan {
	readonly name: string;
	readonly repo: string;
	readonly path: string;
	readonly branch: string;
	readonly base: string;
	readonly ports: {readonly from: number; readonly to: number};
	/** Ports this program has already handed out — skipped on top of whatever the OS refuses. */
	readonly taken: ReadonlyArray<number>;
	/** `null` when the config asked for no env step at all. */
	readonly env: EnvPlan | null;
	readonly setup: ReadonlyArray<string>;
}

export type ProvisionOutcome =
	| {readonly ok: true; readonly port: number}
	| {
			readonly ok: false;
			readonly step: ProvisionStep;
			readonly detail: string;
			/**
			 * The half-built worktree the release step **kept**, or `null` when there was none to keep.
			 * The compensation for a failed provision is recording, not deleting: the path is how
			 * `:<id> close <name>` takes the tree away later, and the tree is the evidence of what
			 * happened. See this module's header.
			 */
			readonly kept: string | null;
	  };

/**
 * The first port in the range that nothing else holds. `taken` is checked before the probe because
 * a port this program handed out two seconds ago may not be bound *yet* — the dev server inside
 * that workspace has not started — and the OS would happily offer it again.
 */
export const pickPort = (
	range: {readonly from: number; readonly to: number},
	taken: ReadonlyArray<number>,
): Effect.Effect<number | null, never, Machine> =>
	Effect.gen(function* () {
		for (let port = range.from; port <= range.to; port += 1) {
			if (taken.includes(port)) continue;
			if (yield* ask((runner) => runner.portFree(port))) return port;
		}
		return null;
	});

/**
 * The worktree, acquired. The release is the compensation, and it **records** — on a scope that
 * ended in failure it writes the path down as kept, and on a scope that succeeded it does nothing.
 * Nothing in this package deletes a tree that a later step failed on.
 */
const acquireWorktree = (
	plan: ProvisionPlan,
	kept: Ref.Ref<string | null>,
): Effect.Effect<string, WorktreeFailed, Machine | Scope.Scope> =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const added = yield* ask((runner) =>
				runner.exec(`git worktree add -b ${plan.branch} ${plan.path} ${plan.base}`, plan.repo),
			);
			if (!added.ok) {
				return yield* Effect.fail(new WorktreeFailed({output: added.output}));
			}
			return plan.path;
		}),
		(path, exit) => (Exit.isFailure(exit) ? Ref.set(kept, path) : Effect.void),
	);

/** The `.env`, written into the worktree — or nothing at all, for a config that declared none. */
const writeEnv = (
	plan: ProvisionPlan,
	vars: Vars,
	port: number,
): Effect.Effect<void, EnvTemplateMissing | EnvWriteFailed, Machine> =>
	Effect.gen(function* () {
		const env = plan.env;
		if (env === null) return;
		const template = yield* ask((runner) => runner.readFile(join(plan.repo, env.template)));
		if (template === null) {
			return yield* Effect.fail(new EnvTemplateMissing({template: env.template}));
		}
		const assignments: ReadonlyArray<readonly [string, string]> = [
			[env.portKey, String(port)],
			...Object.entries(env.vars).map(([key, value]) => [key, substitute(value, vars)] as const),
		];
		const file = join(plan.path, env.file);
		const written = yield* ask((runner) =>
			runner.writeFile(file, rewriteEnv(template, assignments)),
		);
		if (!written.ok) {
			return yield* Effect.fail(new EnvWriteFailed({file, detail: written.detail}));
		}
	});

/** Every setup command, in order, inside the worktree. The first failure wins. */
const runSetup = (plan: ProvisionPlan, vars: Vars): Effect.Effect<void, SetupFailed, Machine> =>
	Effect.gen(function* () {
		for (const command of plan.setup) {
			const line = substitute(command, vars);
			const result = yield* ask((runner) => runner.exec(line, plan.path));
			if (!result.ok) {
				return yield* Effect.fail(new SetupFailed({command: line, output: result.output}));
			}
		}
	});

/** The whole of `open`, in order — and the order is the four statements below. */
export const provision = (plan: ProvisionPlan): Effect.Effect<ProvisionOutcome, never, Machine> =>
	Effect.gen(function* () {
		const kept = yield* Ref.make<string | null>(null);
		const steps = Effect.gen(function* () {
			yield* acquireWorktree(plan, kept);

			const port = yield* pickPort(plan.ports, plan.taken);
			if (port === null) {
				return yield* Effect.fail(new NoFreePort({from: plan.ports.from, to: plan.ports.to}));
			}

			const vars: Vars = {
				NAME: plan.name,
				PORT: String(port),
				WORKTREE: plan.path,
				BRANCH: plan.branch,
			};

			yield* writeEnv(plan, vars, port);
			yield* runSetup(plan, vars);
			return port;
		});
		return yield* Effect.scoped(steps).pipe(
			Effect.matchEffect({
				onSuccess: (port): Effect.Effect<ProvisionOutcome> => Effect.succeed({ok: true, port}),
				// The failure arm reads `kept` *after* the scope closed, which is the only moment the
				// release has run and the answer is known.
				onFailure: (error: ProvisionError): Effect.Effect<ProvisionOutcome> =>
					Effect.map(Ref.get(kept), (path) => ({
						ok: false,
						step: STEP_OF[error._tag],
						detail: detailOf(error),
						kept: path,
					})),
			}),
		);
	});

// -- Close ------------------------------------------------------------------

/** Everything one `close` needs. */
export interface TeardownPlan {
	readonly name: string;
	readonly repo: string;
	readonly path: string;
	readonly branch: string;
	readonly port: number | null;
	readonly commands: ReadonlyArray<string>;
	/**
	 * Pass `--force` to `git worktree remove`, which throws away uncommitted work. `false` for every
	 * `:<id> close` and every Close button; `true` only for `:<id> discard`.
	 */
	readonly force: boolean;
}

/** A `teardown` command the config wrote failed, so the removal never ran. */
// biome-ignore lint/plugin: this package publishes to npm and its errors cross into a user's `tuval.config.ts`, not phoenix's fate wire — there is no `FateWireCode` for the annotation to carry, and the move keeps the error surface it arrived with (#9406).
export class TeardownCommandFailed extends Data.TaggedError("TeardownCommandFailed")<{
	readonly command: string;
	readonly output: string;
}> {}

/** Git refused to remove the worktree — which is what a dirty tree does with no `--force`. */
// biome-ignore lint/plugin: this package publishes to npm and its errors cross into a user's `tuval.config.ts`, not phoenix's fate wire — there is no `FateWireCode` for the annotation to carry, and the move keeps the error surface it arrived with (#9406).
export class RemoveRefused extends Data.TaggedError("RemoveRefused")<{
	readonly output: string;
}> {}

export type TeardownError = TeardownCommandFailed | RemoveRefused;

/** Which half of a close refused: a command the config wrote, or git's own removal. */
export type TeardownStage = "teardown" | "remove";

const STAGE_OF: Readonly<Record<TeardownError["_tag"], TeardownStage>> = {
	TeardownCommandFailed: "teardown",
	RemoveRefused: "remove",
};

const teardownDetail = (error: TeardownError): string =>
	error._tag === "TeardownCommandFailed"
		? safeDetail(`${error.command}: ${error.output}`)
		: safeDetail(error.output);

export type TeardownOutcome =
	| {readonly ok: true}
	| {
			readonly ok: false;
			readonly stage: TeardownStage;
			readonly detail: string;
	  };

/**
 * Teardown, then removal — and **neither half is allowed to throw work away on its own**.
 *
 * The removal does not happen if a teardown command failed, which `Effect.gen` states by being a
 * sequence: a failed command short-circuits and the `git worktree remove` below it is never
 * reached. A `dropdb` that did not work means the scratch database is still there; removing the
 * worktree on top of that would delete the only thing that knows which database it was.
 *
 * And the removal itself asks git **without `--force`** unless the plan said otherwise. An
 * uncommitted change in a worktree is work, and `git worktree remove <path>` refuses rather than
 * deleting it; that refusal comes back exactly like a failed teardown command's — `{ok: false}`
 * with git's own message — so the record survives holding the reason. `--force` reaches here from
 * one place and one only: `:<id> discard <name>`, the spell whose name says it loses work.
 */
export const teardown = (plan: TeardownPlan): Effect.Effect<TeardownOutcome, never, Machine> =>
	Effect.gen(function* () {
		const vars: Vars = {
			NAME: plan.name,
			PORT: plan.port === null ? "" : String(plan.port),
			WORKTREE: plan.path,
			BRANCH: plan.branch,
		};
		for (const command of plan.commands) {
			const line = substitute(command, vars);
			const result = yield* ask((runner) => runner.exec(line, plan.path));
			if (!result.ok) {
				return yield* Effect.fail(
					new TeardownCommandFailed({command: line, output: result.output}),
				);
			}
		}
		const removed = yield* ask((runner) =>
			runner.exec(`git worktree remove ${plan.path}${plan.force ? " --force" : ""}`, plan.repo),
		);
		if (!removed.ok) {
			return yield* Effect.fail(new RemoveRefused({output: removed.output}));
		}
	}).pipe(
		Effect.match({
			onSuccess: (): TeardownOutcome => ({ok: true}),
			onFailure: (error: TeardownError): TeardownOutcome => ({
				ok: false,
				stage: STAGE_OF[error._tag],
				detail: teardownDetail(error),
			}),
		}),
	);

/**
 * Which recorded workspaces are not on disk any more. Read-only by construction — the caller marks
 * them `gone`, and nobody deletes anything: a record whose directory a person removed by hand is
 * the last evidence that the directory was ever supposed to be there.
 */
export const reconcile = (
	records: ReadonlyArray<{readonly name: string; readonly path: string}>,
): Effect.Effect<ReadonlyArray<string>, never, Machine> =>
	Effect.gen(function* () {
		const checked = yield* Effect.forEach(
			records,
			(record) =>
				Effect.map(
					ask((runner) => runner.exists(record.path)),
					(there) => ({name: record.name, there}),
				),
			{concurrency: "unbounded"},
		);
		return checked.filter((one) => !one.there).map((one) => one.name);
	});
