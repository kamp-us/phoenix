/**
 * `worktree`, driven with `testProgram` — no kernel, no desk, no git.
 *
 * What this file pins is the machine: what a name may be, what may happen while something is in
 * flight, what a tile says about it, and **which effect each cell answers** — because an effect is
 * now the whole of how this program asks for work, and a cell that answers the wrong one is a
 * worktree that never gets provisioned. The handlers are driven here too, over the recording fake:
 * `./provision.ts` has its own suite, so what is asserted below is the join — the effect a cell
 * answered, handed to the handler that takes it, and the events it answers fed back into `update`.
 *
 * Beside that, the two seams a consumer meets: the shape fit against a real `claudeSession` row,
 * and the fixture config's own rows.
 */

import {PromptPayloadSchema, type TurnResult, TurnResultSchema} from "@kampus/tuval/ai-agent/ports";
import {
	type Answer,
	type AnyProgram,
	emit,
	type PortSchema,
	ProcessId,
	Program,
	type ShapeSource,
	STATUS_PORT,
	send,
	spawn,
	stop,
	TITLE_PORT,
	testProgram,
} from "@kampus/tuval/authoring";
import {ClientId, claudeSession, WorkspaceId} from "@kampus/tuval/sessions";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import config, {desk, reviews} from "../.tuval/tuval.config.ts";
import {fakeRunner} from "./fake-runner.ts";
import {WORKTREE_WINDOW_REF} from "./renderer-ref.ts";
import {
	closeEvent,
	discardEvent,
	LIMIT,
	REFUSAL_LIMIT,
	UNATTRIBUTED_LIMIT,
	type WorktreeState,
} from "./state.ts";
import {
	closePlan,
	freshRecord,
	openPlan,
	preface,
	provisionEffect,
	settle,
	teardownEffect,
	type WorktreeEffect,
	type WorktreeEvent,
	worktree,
	worktreeHandlers,
	worktreeProgram,
} from "./worktree.ts";

const SEVEN = new Date(2026, 8, 10, 7, 0, 12).getTime();

/** The authored record this file drives, named so the cast below can narrow one field of it. */
type Authored = ReturnType<typeof worktreeProgram>;

/**
 * The same record with its `update` narrowed back to the six kernel effects.
 *
 * `testProgram` is typed at `AuthoredProgram<S, D, U, C, Out>` — five arguments, so the author's
 * own effect type sits on its `never` default (`apps/tuval/src/authoring/test-program.ts`) — and a
 * program that answers an effect of its own therefore does not fit its signature, though the run
 * itself is entirely agnostic: it puts whatever a cell answered into `effects` and reads none of
 * it. This is that gap, in one place. Every other type survives the cast, so `.send`'s port names,
 * `.event`'s events and `run.state` stay checked. Filed upstream as kamp-us/phoenix
 * [#9296](https://github.com/kamp-us/phoenix/issues/9296) — the day `testProgram` takes `X`, this
 * alias and the cast below go with it.
 */
type Drivable = Omit<Authored, "update"> & {
	readonly update: {
		[K in keyof Authored["update"]]: (
			...args: Parameters<Authored["update"][K]>
		) => Answer<WorktreeState>;
	};
};

// biome-ignore lint/plugin: the cast IS the bridge — `testProgram` takes the kernel's own `Program` shape and `Drivable` above is this suite's narrower re-statement of the half it drives; these are function values, so there is no wire to decode at. Removed by kamp-us/phoenix#9296, which the docblock above names.
const drive = (program: Authored) => testProgram(program as unknown as Drivable);

/** A run's effects as tagged data, which is how the actor reads them when it dispatches one. */
const asked = (run: {
	readonly effects: ReadonlyArray<unknown>;
}): ReadonlyArray<{readonly type: string}> => run.effects as ReadonlyArray<{readonly type: string}>;

/** The one effect of a given tag a run asked for, or a failure that names what it asked for. */
const only = <T extends WorktreeEffect["type"]>(
	run: {readonly effects: ReadonlyArray<unknown>},
	type: T,
): Extract<WorktreeEffect, {readonly type: T}> => {
	const found = asked(run).filter((effect) => effect.type === type);
	if (found.length !== 1) {
		throw new Error(
			`expected one ${type}, got ${JSON.stringify(asked(run).map((one) => one.type))}`,
		);
	}
	return found[0] as Extract<WorktreeEffect, {readonly type: T}>;
};

const options = {
	repo: "/repo",
	now: () => SEVEN,
	runner: fakeRunner(),
} as const;

const agent = ProcessId.make("proc-agent");
/** A second agent, for the cases where "which one answered" is the thing under test. */
const other = ProcessId.make("proc-other");

/** The shaped arg a worktree program spawns through — the `Spawnable` half of the shape. */
const jobRef = worktreeProgram({...options, job: {} as ShapeSource}).args.job;

const turn = (text: string, ok: boolean): TurnResult => ({
	text,
	items: [],
	ok,
});

const scope = {
	workspace: WorkspaceId.make("tuval/test"),
	client: ClientId.make("tuval/test"),
};

/** A real session row, built the way a config builds one. */
const session = (): AnyProgram =>
	claudeSession({
		cwd: "/repo",
		scope: {...scope, client: ClientId.make("tuval-desk")},
	});

const portsOf = (row: AnyProgram): Readonly<Record<string, PortSchema>> => row.ports;

/** A program with a job filled, which is the one that spawns. */
const withJob = () => worktreeProgram({...options, job: session() as ShapeSource});

describe("a worktree program says what it is before anything has happened", () => {
	it("publishes the repository it serves and an empty board", () => {
		const run = drive(worktreeProgram(options));
		expect(run.state).toEqual({
			repo: "/repo",
			repoName: "repo",
			root: "/repo/.worktrees",
			base: "origin/main",
			worktrees: [],
			pending: null,
			seq: 0,
			spawningFor: null,
			refusals: [],
			unattributed: [],
		});
		expect(run.effects).toEqual([
			emit(TITLE_PORT, "worktree · repo"),
			emit(STATUS_PORT, "0 open · nothing open"),
		]);
	});

	it("takes the declared inputs it was given over its defaults", () => {
		const run = drive(
			worktreeProgram({
				...options,
				id: "lane",
				repo: "/code/phoenix",
				root: ".lanes",
				base: "origin/next",
				branchPrefix: "build/",
			}),
		);
		expect(run.state.root).toBe("/code/phoenix/.lanes");
		expect(run.state.base).toBe("origin/next");
		expect(run.effects).toContainEqual(emit(TITLE_PORT, "lane · phoenix"));
	});

	it("refuses an id that is not a word, at the config call rather than at boot", () => {
		expect(() => worktreeProgram({...options, id: ""})).toThrow(/non-empty word/);
		expect(() => worktreeProgram({...options, id: "my worktree"})).toThrow(/no spaces/);
	});

	it("refuses an empty repo and a backwards port range where they are written", () => {
		expect(() => worktreeProgram({...options, repo: "  "})).toThrow(/cannot be empty/);
		expect(() => worktreeProgram({...options, port: {from: 5199, to: 5170}})).toThrow(
			/must run upwards/,
		);
	});
});

describe("open", () => {
	const opened = () => drive(worktreeProgram(options)).send("open", {name: "feature-x"});

	it("records the worktree and queues the provision, in that order and in one step", () => {
		const run = opened();
		expect(run.state.worktrees).toEqual([
			{
				name: "feature-x",
				path: "/repo/.worktrees/feature-x",
				branch: "can/feature-x",
				port: null,
				status: "provisioning",
				agent: null,
				detail: null,
				openedAt: SEVEN,
			},
		]);
		expect(run.state.pending).toEqual({
			kind: "open",
			seq: 1,
			name: "feature-x",
			prompt: "",
		});
		// Nothing is asked of the *kernel* — the agent comes later, once the directory exists.
		expect(run.effects.filter((effect) => effect.type === "spawn")).toEqual([]);
	});

	it("answers one `worktree.provision`, carrying the plan it derived on the spot", () => {
		const run = opened();
		const settled = settle(options);
		expect(only(run, "worktree.provision")).toEqual(
			provisionEffect(openPlan(settled, freshRecord(settled, "feature-x"), [])),
		);
	});

	it("names the ports it has already handed out, so a probe cannot hand one out twice", () => {
		const run = drive(worktreeProgram(options))
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.send("open", {name: "bugfix"});
		expect(only(run, "worktree.provision").plan.taken).toEqual([5174]);
	});

	it("asks for nothing at all when it refuses, beyond writing the refusal down", () => {
		const refusal = opened().send("open", {name: "feature-x"});
		expect(asked(refusal).map((effect) => effect.type)).not.toContain("worktree.provision");
	});

	it("says on the tile what it is doing, by name", () => {
		expect(opened().effects).toContainEqual(emit(STATUS_PORT, "0 open · provisioning feature-x"));
	});

	it("carries the branch prefix the config chose", () => {
		const run = drive(worktreeProgram({...options, branchPrefix: "build/"})).send("open", {
			name: "9287",
		});
		expect(run.state.worktrees[0]?.branch).toBe("build/9287");
		expect(run.state.worktrees[0]?.path).toBe("/repo/.worktrees/9287");
	});

	it("refuses a second open of a name it already holds, and says so", () => {
		const first = opened();
		const again = first.send("open", {name: "feature-x"});
		expect(again.state.worktrees).toEqual(first.state.worktrees);
		expect(again.state.pending).toEqual(first.state.pending);
		expect(again.state.refusals).toEqual([{name: "feature-x", reason: "duplicate", at: SEVEN}]);
	});

	it("refuses a name a branch and a directory cannot both be called, and says so", () => {
		const run = drive(worktreeProgram(options))
			.send("open", {name: "../escape"})
			.send("open", {name: "with space"})
			.send("open", {name: ""});
		expect(run.state.worktrees).toEqual([]);
		expect(run.state.pending).toBeNull();
		expect(run.state.refusals.map((one) => one.reason)).toEqual(["name", "name", "name"]);
		// Newest first, so the tile says the one that just happened.
		expect(run.state.refusals[0]?.name).toBe("");
		expect(run.effects).toContainEqual(
			emit(STATUS_PORT, "0 open · nothing open · refused (unnamed): name"),
		);
	});

	it("refuses a second open while one is still provisioning, and says so", () => {
		const busy = opened();
		const second = busy.send("open", {name: "bugfix"});
		expect(second.state.worktrees).toHaveLength(1);
		expect(second.state.pending).toMatchObject({name: "feature-x"});
		expect(second.state.refusals).toEqual([{name: "bugfix", reason: "busy", at: SEVEN}]);
		expect(second.effects).toContainEqual(
			emit(STATUS_PORT, "0 open · provisioning feature-x · refused bugfix: busy"),
		);
	});

	it("refuses past the bound, because each of these is a whole checkout, and says so", () => {
		let run = drive(worktreeProgram(options));
		for (let index = 0; index < LIMIT + 2; index += 1) {
			run = run
				.send("open", {name: `w${index}`})
				.event({type: "provisioned", name: `w${index}`, port: 5170 + index});
		}
		expect(run.state.worktrees).toHaveLength(LIMIT);
		expect(run.state.refusals.map((one) => one.reason)).toEqual(["limit", "limit"]);
	});

	it("bounds the refusals it keeps, so the list is a window and not a log", () => {
		let run = drive(worktreeProgram(options));
		for (let index = 0; index < REFUSAL_LIMIT + 3; index += 1) {
			run = run.send("open", {name: "with space"});
		}
		expect(run.state.refusals).toHaveLength(REFUSAL_LIMIT);
	});
});

describe("provisioned, and the agent inside", () => {
	const ready = (program = withJob()) =>
		drive(program)
			.send("open", {name: "feature-x", brief: "Fix the flaky test."})
			.event({type: "provisioned", name: "feature-x", port: 5174});

	it("records the port the probe found and opens the worktree", () => {
		const run = ready();
		expect(run.state.worktrees[0]).toMatchObject({
			name: "feature-x",
			port: 5174,
			status: "open",
		});
		expect(run.state.pending).toBeNull();
	});

	it("says `1 open · feature-x :5174 idle` until an agent is up", () => {
		expect(ready().effects).toContainEqual(emit(STATUS_PORT, "1 open · feature-x :5174 idle"));
	});

	it("asks for the agent only once the directory it will work in exists", () => {
		const run = ready();
		expect(run.effects).toContainEqual(spawn(jobRef, {on: {result: "result"}}));
		expect(run.state.spawningFor).toEqual({
			name: "feature-x",
			brief: "Fix the flaky test.",
		});
	});

	it("asks for no agent at all when the config filled no job", () => {
		const run = drive(worktreeProgram(options))
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174});
		expect(run.effects.filter((effect) => effect.type === "spawn")).toEqual([]);
		expect(run.state.spawningFor).toBeNull();
	});

	it("tells the session where it is, because a spawn could not (phoenix#9287)", () => {
		const run = ready().event({
			type: "spawned",
			process: agent,
			program: "claude-session",
		});
		const sent = run.effects.find((effect) => effect.type === "send");
		expect(sent).toEqual({
			type: "send",
			to: {process: agent, port: "prompt"},
			payload: {
				text: "You are working in /repo/.worktrees/feature-x on branch can/feature-x; dev port 5174. Start by changing into that directory — it is a git worktree of its own and it is not where this session started.\n\nFix the flaky test.",
				key: `worktree-feature-x-${SEVEN}`,
				timestamp: SEVEN,
			},
		});
		// The payload the session's own port admits, not just one this program happened to build.
		expect(portsOf(session()).prompt?.accepts((sent as {readonly payload: unknown}).payload)).toBe(
			true,
		);
		expect(run.state.worktrees[0]?.agent).toBe(agent);
	});

	it("puts the config's standing brief before the one the spell carried", () => {
		const run = drive(
			worktreeProgram({
				...options,
				brief: "Run everything through `nix develop -c`.",
				job: session() as ShapeSource,
			}),
		)
			.send("open", {name: "feature-x", brief: "Fix the flaky test."})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.event({type: "spawned", process: agent, program: "claude-session"});
		const sent = run.effects.find((effect) => effect.type === "send") as {
			readonly payload: {readonly text: string};
		};
		expect(sent.payload.text).toContain(
			"Run everything through `nix develop -c`.\n\nFix the flaky test.",
		);
	});

	it("attributes a turn to the one worktree whose agent is up", () => {
		const answered = ready()
			.event({type: "spawned", process: agent, program: "claude-session"})
			.event({type: "result", payload: turn("done, two files", true)});
		expect(answered.state.worktrees[0]?.detail).toBe("done, two files");
		expect(answered.state.unattributed).toEqual([]);
	});

	it("attributes nothing when two agents are up, because a reply carries no sender", () => {
		// phoenix#9287's sibling gap: `Reply` is `{type, payload}` (authoring/effect.ts:179-182), so
		// with B answering there is nothing in the event that distinguishes it from A. The old code
		// took the first worktree holding an agent, which put B's reply on A's row.
		const two = drive(withJob())
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.event({type: "spawned", process: agent, program: "claude-session"})
			.send("open", {name: "bugfix"})
			.event({type: "provisioned", name: "bugfix", port: 5175})
			.event({type: "spawned", process: other, program: "claude-session"})
			.event({type: "result", payload: turn("B is done\nrest", true)});
		expect(two.state.worktrees.map((one) => one.detail)).toEqual([null, null]);
		expect(two.state.unattributed).toEqual([{text: "B is done", at: SEVEN}]);
		expect(two.effects).toContainEqual(
			emit(STATUS_PORT, "2 open · bugfix :5175 running · 1 unattributed"),
		);
	});

	it("keeps a reply that arrived with no agent up at all, rather than dropping it", () => {
		const none = drive(worktreeProgram(options))
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.event({type: "result", payload: turn("from nowhere", true)});
		expect(none.state.unattributed).toEqual([{text: "from nowhere", at: SEVEN}]);
	});

	it("bounds the unowned list, for the reason every other list here is bounded", () => {
		let run = drive(withJob())
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174});
		for (let index = 0; index < UNATTRIBUTED_LIMIT + 3; index += 1) {
			run = run.event({
				type: "result",
				payload: turn(`t${index}`, true),
			});
		}
		expect(run.state.unattributed).toHaveLength(UNATTRIBUTED_LIMIT);
	});

	it("says `running` once an agent is up, and keeps the session after a turn", () => {
		const up = ready().event({
			type: "spawned",
			process: agent,
			program: "claude-session",
		});
		expect(up.effects).toContainEqual(emit(STATUS_PORT, "1 open · feature-x :5174 running"));
		const answered = up.event({
			type: "result",
			payload: turn("done, two files\nand the rest", true),
		});
		// Unlike cron, nothing stops the session: a worktree is a place to work, not one question —
		// and the tile does not move either, because "running" is still the true sentence.
		expect(answered.effects).toEqual([]);
		expect(answered.state.worktrees[0]?.detail).toBe("done, two files");
		expect(answered.state.worktrees[0]?.agent).toBe(agent);
	});

	it("frees the agent when it ends, and leaves the worktree standing", () => {
		const run = ready()
			.event({type: "spawned", process: agent, program: "claude-session"})
			.event({type: "stopped", process: agent});
		expect(run.state.worktrees[0]?.agent).toBeNull();
		expect(run.state.worktrees[0]?.status).toBe("open");
	});
});

describe("a provision that stopped", () => {
	const failed = () =>
		drive(worktreeProgram(options)).send("open", {name: "feature-x"}).event({
			type: "provisionFailed",
			name: "feature-x",
			step: "setup",
			detail: "pnpm install: ERR_PNPM_LOCKFILE",
		});

	it("keeps the record, because the half-built worktree still has to be removable", () => {
		const run = failed();
		expect(run.state.worktrees[0]).toMatchObject({
			name: "feature-x",
			status: "failed",
			detail: "setup: pnpm install: ERR_PNPM_LOCKFILE",
			path: "/repo/.worktrees/feature-x",
		});
		expect(run.state.pending).toBeNull();
	});

	it("frees the program to take the next open", () => {
		const run = failed().send("open", {name: "bugfix"});
		expect(run.state.pending).toMatchObject({name: "bugfix"});
	});
});

/**
 * **The seam itself**: a cell answers an effect, the handler the row is spread with is invoked with
 * *that value*, and the events it answers land back on `update`. Three tests, and between them they
 * are the whole round trip — which is the thing neither `./provision.ts`'s suite nor the reducer
 * cases above can see, because each of those only ever holds one end of it.
 */
describe("the seam — the compiled row and the handlers spread onto it", () => {
	/**
	 * The one thing `defineProgram` cannot check. It returns before any spread exists, so a program
	 * that names an effect and forgets its handler compiles clean and the actor then skips that
	 * effect *silently* (kamp-us/phoenix#9295) — a worktree that is never provisioned and no error
	 * anywhere. This case is that check, moved to where one can be made.
	 */
	it("answers every effect this program names, and keeps the six the kernel wrote", () => {
		const keys = Object.keys(worktree({...options}).handlers);
		expect(keys).toEqual(
			expect.arrayContaining(["worktree.provision", "worktree.teardown", "worktree.reconcile"]),
		);
		// The spread adds; it must never replace. A row that lost `spawn` could not start an agent.
		expect(keys).toEqual(expect.arrayContaining(["emit", "spawn", "send", "ask", "reply", "stop"]));
	});

	it("answers them on the row with a job filled too, which is the other branch", () => {
		const keys = Object.keys(worktree({...options, job: session() as ShapeSource}).handlers);
		expect(keys).toEqual(
			expect.arrayContaining([
				"worktree.provision",
				"worktree.teardown",
				"worktree.reconcile",
				"spawn",
			]),
		);
	});

	it("runs those handlers over the `Runner` the row was configured with", async () => {
		const runner = fakeRunner();
		const row = worktree({...options, runner});
		const effect = teardownEffect(
			closePlan(
				settle({...options, runner}),
				freshRecord(settle({...options, runner}), "feature-x"),
				false,
			),
		);
		await Effect.runPromise(row.handlers["worktree.teardown"](effect) as Effect.Effect<unknown>);
		// The fake, not the machine: `machineLayer(settled.runner)` is provided inside the handler.
		expect(runner.commands()).toEqual(["git worktree remove /repo/.worktrees/feature-x"]);
	});
});

describe("the effect a cell answered, run by the handler that takes it", () => {
	/** What the actor does: look the handler up by `type`, hand it the effect, dispatch every event. */
	const perform = async (
		settledOptions: typeof options,
		effect: WorktreeEffect,
	): Promise<ReadonlyArray<WorktreeEvent>> => {
		const handlers = worktreeHandlers(settle(settledOptions));
		return await Effect.runPromise(handlers[effect.type](effect as never));
	};

	it("provisions the plan the `open` cell derived and answers `provisioned`", async () => {
		const runner = fakeRunner({
			files: {"/repo/.env.example": "PORT=3000\n"},
		});
		const withRunner = {...options, runner};
		const queued = drive(worktreeProgram(withRunner)).send("open", {
			name: "feature-x",
		});

		const events = await perform(withRunner, only(queued, "worktree.provision"));
		expect(events).toEqual([{type: "provisioned", name: "feature-x", port: 5170}]);

		// The worktree, the probe and the `.env` — the order *is* the contract (`./provision.ts`).
		expect(runner.commands()).toEqual([
			"git worktree add -b can/feature-x /repo/.worktrees/feature-x origin/main",
		]);
		expect(runner.written.get("/repo/.worktrees/feature-x/.env")).toBe("PORT=5170\n");

		// And the event reaches `update`, which is what makes it a round trip rather than a call.
		const run = events.reduce((step, event) => step.event(event), queued);
		expect(run.state.worktrees[0]).toMatchObject({
			status: "open",
			port: 5170,
		});
		expect(run.state.pending).toBeNull();
	});

	it("tears down the plan the `close` cell derived, with no `--force` anywhere", async () => {
		const runner = fakeRunner();
		const withRunner = {...options, runner};
		const closed = drive(worktreeProgram(withRunner))
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.send("close", {name: "feature-x"});

		const events = await perform(withRunner, only(closed, "worktree.teardown"));
		expect(events).toEqual([{type: "closed", name: "feature-x"}]);
		expect(runner.commands()).toEqual(["git worktree remove /repo/.worktrees/feature-x"]);

		const run = events.reduce((step, event) => step.event(event), closed);
		expect(run.state.worktrees).toEqual([]);
	});

	it("is the only thing that forces, and only under `discard`", async () => {
		const runner = fakeRunner();
		const withRunner = {...options, runner};
		const discarded = drive(worktreeProgram(withRunner))
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.send("discard", {name: "feature-x"});

		await perform(withRunner, only(discarded, "worktree.teardown"));
		expect(runner.commands()).toEqual(["git worktree remove /repo/.worktrees/feature-x --force"]);
	});
});

describe("a refused write, through the whole chain", () => {
	/**
	 * The one case the two halves' own suites cannot see between them, so it is driven end to end:
	 * the real handler over the real `provision` over a machine that refuses the `.env` write, and
	 * the event it answers with fed back into the real reducer.
	 *
	 * `writeFile` used to be the one `Runner` method allowed to throw, and a throwing one does not
	 * fail a provision — it *kills* it. A rejected promise inside `Effect.promise` is a defect, the
	 * handler dies, no event is dispatched, so `pending` stays set for ever and every later open and
	 * close is refused "busy" until the process restarts. The port answers instead, and what that
	 * buys is the three assertions below.
	 */
	const runner = fakeRunner({
		files: {"/repo/.env.example": "PORT=3000\n"},
		unwritable: {
			"/repo/.worktrees/feature-x/.env": "EROFS: read-only file system",
		},
	});
	const withRunner = {...options, runner};

	const answered = async () => {
		const queued = drive(worktreeProgram(withRunner)).send("open", {
			name: "feature-x",
		});
		const handlers = worktreeHandlers(settle(withRunner));
		const events = await Effect.runPromise(
			handlers["worktree.provision"](only(queued, "worktree.provision")),
		);
		if (events.length === 0) throw new Error("the handler said nothing");
		return events.reduce((step, event) => step.event(event), queued);
	};

	it("records the failure at the env step rather than going quiet", async () => {
		const run = await answered();
		expect(run.state.worktrees[0]).toMatchObject({
			name: "feature-x",
			status: "failed",
			detail: "env: could not write /repo/.worktrees/feature-x/.env: EROFS: read-only file system",
		});
	});

	it("clears `pending`, so the program is not wedged busy", async () => {
		const run = await answered();
		expect(run.state.pending).toBeNull();
	});

	it("takes the next open", async () => {
		const run = (await answered()).send("open", {name: "bugfix"});
		expect(run.state.pending).toMatchObject({name: "bugfix"});
		expect(run.state.refusals).toEqual([]);
	});
});

describe("close", () => {
	const open = () =>
		drive(withJob())
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.event({type: "spawned", process: agent, program: "claude-session"});

	it("stops the agent first, and asks for nothing else until that ending lands", () => {
		const run = open().send("close", {name: "feature-x"});
		expect(run.effects).toContainEqual(stop(agent));
		expect(run.state.worktrees[0]).toMatchObject({
			status: "closing",
			agent: null,
		});
		expect(run.state.pending).toEqual({
			kind: "close",
			seq: 2,
			name: "feature-x",
			force: false,
			stopping: agent,
		});
		// The removal is *not* in this list. `[stop, teardown]` would make the removal conditional on
		// the stop having worked, and `Processes.stop` fails `ProcessNotFound` on a process already
		// gone — see `closing` in `./worktree.ts`.
		expect(asked(run).map((effect) => effect.type)).not.toContain("worktree.teardown");
	});

	it("answers one `worktree.teardown` when the ending lands, with a plan that does not force", () => {
		const run = open().send("close", {name: "feature-x"}).event({type: "stopped", process: agent});
		const settled = settle(options);
		const record = {...freshRecord(settled, "feature-x"), port: 5174};
		expect(only(run, "worktree.teardown")).toEqual(
			teardownEffect(closePlan(settled, record, false)),
		);
		expect(only(run, "worktree.teardown").plan.force).toBe(false);
	});

	/**
	 * The regression this two-step exists for. An agent that crashed before its `stopped` was folded
	 * in is a `stop` the kernel refuses `ProcessNotFound` — and the actor runs a cell's effects
	 * serially, so under `[stop(agent), teardownEffect(…)]` that refusal took the removal with it:
	 * the worktree stayed, `pending` stayed `{kind: "close"}`, and every later spell was refused
	 * "busy" until the process restarted. Here the ending arrives first, so `closing` sees no live
	 * agent and the removal is asked for on the spot with no `stop` in front of it to fail.
	 */
	it("still removes the worktree when the agent was already gone", async () => {
		const runner = fakeRunner();
		const withRunner = {...options, runner};
		const gone = drive(worktreeProgram({...withRunner, job: session() as ShapeSource}))
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.event({type: "spawned", process: agent, program: "claude-session"})
			.event({type: "stopped", process: agent})
			.send("close", {name: "feature-x"});

		// No `stop` is asked for, so there is nothing in front of the removal that can refuse.
		expect(asked(gone).map((effect) => effect.type)).not.toContain("stop");
		const effect = only(gone, "worktree.teardown");

		const events = await Effect.runPromise(
			worktreeHandlers(settle(withRunner))["worktree.teardown"](effect),
		);
		expect(runner.commands()).toEqual(["git worktree remove /repo/.worktrees/feature-x"]);

		const run = events.reduce((step, event) => step.event(event), gone);
		expect(run.state.worktrees).toEqual([]);
		expect(run.state.pending).toBeNull();
		// And the program is not wedged: the next open is taken rather than refused "busy".
		expect(run.send("open", {name: "bugfix"}).state.refusals).toEqual([]);
	});

	it("waits for the ending of the agent it named, not any agent that happens to end", () => {
		const two = drive(withJob())
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.event({type: "spawned", process: agent, program: "claude-session"})
			.send("close", {name: "feature-x"})
			// `other` belongs to no worktree here; what matters is that it is not the one being awaited.
			.event({type: "stopped", process: other});
		expect(asked(two).map((effect) => effect.type)).not.toContain("worktree.teardown");
		expect(two.event({type: "stopped", process: agent}).effects).toContainEqual(
			teardownEffect(
				closePlan(
					settle(options),
					{...freshRecord(settle(options), "feature-x"), port: 5174},
					false,
				),
			),
		);
	});

	it("frees the record once teardown and the removal are done", () => {
		const run = open()
			.send("close", {name: "feature-x"})
			.event({type: "closed", name: "feature-x"});
		expect(run.state.worktrees).toEqual([]);
		expect(run.state.pending).toBeNull();
		expect(run.effects).toContainEqual(emit(STATUS_PORT, "0 open · nothing open"));
	});

	it("keeps the record as failed when a teardown command refused, holding the reason", () => {
		const run = open().send("close", {name: "feature-x"}).event({
			type: "closeFailed",
			name: "feature-x",
			stage: "teardown",
			detail: "dropdb --if-exists app_feature-x: database is being accessed",
		});
		expect(run.state.worktrees[0]).toMatchObject({
			status: "failed",
			detail: "teardown: dropdb --if-exists app_feature-x: database is being accessed",
		});
	});

	it("keeps the worktree when git refuses to remove a dirty worktree, with git's own reason", () => {
		// The SEV2 this cell exists for: one click used to reach `git worktree remove --force` and
		// uncommitted work went with it. Now the removal is refused, and the refusal is on the record.
		const dirty =
			"fatal: '/repo/.worktrees/feature-x' contains modified or untracked files, use --force to delete it";
		const run = open().send("close", {name: "feature-x"}).event({
			type: "closeFailed",
			name: "feature-x",
			stage: "remove",
			detail: dirty,
		});
		expect(run.state.worktrees).toHaveLength(1);
		expect(run.state.worktrees[0]).toMatchObject({
			name: "feature-x",
			path: "/repo/.worktrees/feature-x",
			branch: "can/feature-x",
			status: "failed",
			detail: `remove: ${dirty}`,
		});
		expect(run.state.pending).toBeNull();
	});

	it("takes a close of a name it does not hold as nothing", () => {
		const run = open().send("close", {name: "never-opened"});
		expect(run.state.pending).toBeNull();
		expect(run.effects).toEqual([]);
	});

	it("never asks for the forcing variant — a Close is a close, from the spell or the button", () => {
		const run = open().send("close", {name: "feature-x"});
		expect(run.state.pending).toMatchObject({kind: "close", force: false});
		// And the event the window's Close button dispatches is the one this port takes.
		expect(closeEvent("feature-x")).toEqual({
			type: "close",
			payload: {name: "feature-x"},
		});
		expect(discardEvent("feature-x").type).toBe("discard");
	});

	it("refuses a close while something is already in flight", () => {
		const provisioning = drive(worktreeProgram(options)).send("open", {
			name: "feature-x",
		});
		const asked = provisioning.send("close", {name: "feature-x"});
		expect(asked.state).toEqual(provisioning.state);
	});
});

describe("discard, which is the only thing that forces", () => {
	const open = () =>
		drive(withJob())
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.event({type: "spawned", process: agent, program: "claude-session"});

	it("queues the same close with `force`, and stops the agent first just the same", () => {
		const run = open().send("discard", {name: "feature-x"});
		expect(run.state.pending).toEqual({
			kind: "close",
			seq: 2,
			name: "feature-x",
			force: true,
			stopping: agent,
		});
		expect(run.effects).toContainEqual(stop(agent));
		expect(run.state.worktrees[0]).toMatchObject({
			status: "closing",
			agent: null,
		});
	});

	it("frees the record once the forced removal is done", () => {
		const run = open()
			.send("discard", {name: "feature-x"})
			.event({type: "closed", name: "feature-x"});
		expect(run.state.worktrees).toEqual([]);
	});

	it("is a spell of its own, named for what it costs", () => {
		const row = worktree({...options, job: session() as ShapeSource});
		expect(row.spells?.map((spell) => spell.path)).toEqual(
			expect.arrayContaining([["open"], ["close"], ["discard"]]),
		);
		const spell = row.spells?.find((one) => one.path[0] === "discard");
		expect(spell?.describe).toContain("uncommitted work is lost");
	});

	it("takes a discard of a name it does not hold as nothing", () => {
		const run = open().send("discard", {name: "never-opened"});
		expect(run.state.pending).toBeNull();
	});
});

describe("a worktree program restarted", () => {
	/** The checkpoint a Ctrl-C mid-provision leaves behind. */
	const interrupted = () =>
		drive(withJob())
			.send("open", {name: "feature-x"})
			.event({type: "provisioned", name: "feature-x", port: 5174})
			.event({type: "spawned", process: agent, program: "claude-session"})
			.send("open", {name: "bugfix"});

	const restarted = () =>
		withJob()
			.resume(interrupted().state)
			.reduce((run, event) => run.event(event), interrupted());

	it("asks to reconcile on every restore, holding a job or not", () => {
		expect(withJob().resume(interrupted().state)).toEqual([{type: "restored"}]);
		expect(
			worktree({...options, job: session() as ShapeSource}).resume?.(interrupted().state),
		).toEqual([{type: "restored"}]);
	});

	it("writes the interrupted job down as failed and queues the disk check", () => {
		const run = restarted();
		const bugfix = run.state.worktrees.find((one) => one.name === "bugfix");
		expect(bugfix).toMatchObject({
			status: "failed",
			detail: "interrupted by restart",
		});
		expect(run.state.pending).toEqual({kind: "reconcile", seq: 3});
	});

	it("answers one `worktree.reconcile`, naming every record it just settled", async () => {
		const run = restarted();
		const effect = only(run, "worktree.reconcile");
		expect(effect.records).toEqual(
			run.state.worktrees.map((one) => ({name: one.name, path: one.path})),
		);

		// And the handler reads exactly those paths, over the machine this row was built with.
		const runner = fakeRunner({dirs: ["/repo/.worktrees/feature-x"]});
		const events = await Effect.runPromise(
			worktreeHandlers(settle({...options, runner}))["worktree.reconcile"](effect),
		);
		expect(events).toEqual([{type: "reconciled", missing: ["bugfix"]}]);
		expect(events.reduce((step, event) => step.event(event), run).state.worktrees).toContainEqual(
			expect.objectContaining({name: "bugfix", status: "gone"}),
		);
	});

	it("clears every held agent and asks for no stop, because it cannot know one came back", () => {
		// A restored session's `result` reaches nobody (no `on` record, `unwired` ports) and a `stop`
		// of a process the manifest did not restore fails `ProcessNotFound` out of the resume dispatch,
		// which the kernel catches nowhere — that would fail *boot* in exactly this case.
		const run = restarted();
		expect(run.state.worktrees.every((one) => one.agent === null)).toBe(true);
		expect(run.effects.map((effect) => effect.type)).not.toContain("stop");
		expect(run.effects.map((effect) => effect.type)).not.toContain("send");
	});

	it("records a worktree whose directory somebody removed as `gone`, and keeps it", () => {
		const run = restarted().event({
			type: "reconciled",
			missing: ["feature-x"],
		});
		const feature = run.state.worktrees.find((one) => one.name === "feature-x");
		expect(feature?.status).toBe("gone");
		// Kept, never deleted: the record is now the only evidence the directory was supposed to exist,
		// and it still names the branch somebody will want to look for.
		expect(feature?.path).toBe("/repo/.worktrees/feature-x");
		expect(feature?.branch).toBe("can/feature-x");
		expect(run.state.pending).toBeNull();
	});

	it("leaves a worktree whose directory is still there exactly where it was", () => {
		const run = restarted().event({type: "reconciled", missing: []});
		expect(run.state.worktrees.find((one) => one.name === "feature-x")?.status).toBe("open");
	});

	it("re-reads the four env fields off the config, so a checkpoint cannot pin a stale repo", () => {
		const stale: WorktreeState = {
			...interrupted().state,
			repo: "/old",
			repoName: "old",
			root: "/old/.worktrees",
			base: "origin/master",
		};
		const moved = worktreeProgram({...options, repo: "/code/phoenix"});
		const [back] = moved.update.restored(stale, {type: "restored"});
		expect(back.repo).toBe("/code/phoenix");
		expect(back.repoName).toBe("phoenix");
		expect(back.root).toBe("/code/phoenix/.worktrees");
		expect(back.base).toBe("origin/main");
	});

	it("reconciles once: a second restore over the reconciled state moves no status", () => {
		const reconciled = restarted().event({type: "reconciled", missing: []});
		const again = withJob()
			.resume(reconciled.state)
			.reduce((run, event) => run.event(event), reconciled);
		expect(again.state.worktrees.map((one) => one.status)).toEqual(
			reconciled.state.worktrees.map((one) => one.status),
		);
	});
});

describe("the two spells", () => {
	it("`open` sends to its own program's `open` port and asks for nothing else", () => {
		const run = drive(worktreeProgram(options)).call("open", {name: "feature-x"}, scope);
		// A bare port name, which is what makes the call land on *this* program's live process rather
		// than mint a parentless child of its own.
		expect(run.effects).toEqual([send("open", {name: "feature-x"})]);
	});

	it("`close` does the same, with the one argument it takes", () => {
		const run = drive(worktreeProgram(options)).call("close", {name: "feature-x"}, scope);
		expect(run.effects).toEqual([send("close", {name: "feature-x"})]);
	});

	it("registers both under the program id, which is what `:worktree open` resolves", () => {
		const row = worktree({...options, job: session() as ShapeSource});
		expect(row.spells?.map((spell) => spell.path)).toEqual(
			expect.arrayContaining([["open"], ["close"]]),
		);
	});

	it("declares `name` before `brief`, which is what makes it the first positional argument", () => {
		const ports = portsOf(worktree({...options}));
		expect(ports.open?.accepts({name: "feature-x"})).toBe(true);
		expect(ports.open?.accepts({name: "feature-x", brief: "go"})).toBe(true);
		expect(ports.close?.accepts({name: "feature-x"})).toBe(true);
	});
});

describe("the preface, which is phoenix#9287's fallback and is named as one", () => {
	const record = {
		name: "feature-x",
		path: "/repo/.worktrees/feature-x",
		branch: "can/feature-x",
		port: 5174,
		status: "open" as const,
		agent: null,
		detail: null,
		openedAt: SEVEN,
	};

	it("names the path, the branch and the port, and says to change into the directory", () => {
		expect(preface(record, "")).toBe(
			"You are working in /repo/.worktrees/feature-x on branch can/feature-x; dev port 5174. Start by changing into that directory — it is a git worktree of its own and it is not where this session started.",
		);
	});

	it("says so honestly when there is no port", () => {
		expect(preface({...record, port: null}, "")).toContain("no dev port");
	});
});

describe("the job shape against a real session row", () => {
	it("declares the payloads the real ports admit", () => {
		const ports = portsOf(session());
		expect(ports.prompt?.accepts({text: "hi", key: "k", timestamp: SEVEN})).toBe(true);
		expect(ports.result?.accepts(turn("done", true))).toBe(true);
		expect(ports.prompt?.direction).toBe("in");
		expect(ports.result?.direction).toBe("out");
	});

	it("is fitted by the live row itself, which is why no wrapper stands here", () => {
		// `shapeOf` and `fillArgs` are not public, so the fit is asserted where a consumer meets it:
		// `worktree(…)` runs the fill inside `defineProgram` and throws on a job that does not fit.
		expect(() => worktree({...options, job: session() as ShapeSource})).not.toThrow();
		expect(() =>
			worktree({
				...options,
				job: {id: "not-a-job", ports: {}} as ShapeSource,
			}),
		).toThrow();
		expect(
			Program.shape({
				in: {prompt: PromptPayloadSchema},
				out: {result: TurnResultSchema},
			}),
		).toEqual(worktreeProgram({...options}).args.job.shape);
	});

	it("puts the job on the row's fill, so a spawn on the arg resolves to the session", () => {
		const row = worktree({...options, job: session() as ShapeSource});
		expect(row.args).toEqual({job: "tuval/arg/worktree/job"});
		expect(row.label).toBe("worktree (claude-session)");
	});

	it("declares no args at all with no job, so nothing is left unfilled at config load", () => {
		const row = worktree({...options});
		expect(row.args).toBeUndefined();
		expect(row.label).toBe("worktree (repo)");
	});

	it("keys each row's job fill under its own id, so two never read one another's", () => {
		const one = worktree({
			...options,
			id: "lane",
			job: session() as ShapeSource,
		});
		const two = worktree({
			...options,
			id: "reviews",
			job: session() as ShapeSource,
		});
		expect(one.args).toEqual({job: "tuval/arg/lane/job"});
		expect(two.args).toEqual({job: "tuval/arg/reviews/job"});
	});
});

describe("the window", () => {
	it("names a module renderer on the row, which is the only kind a page can load", () => {
		const row = worktree({...options, job: session() as ShapeSource});
		expect(row.renderer).toEqual({
			kind: "module",
			ref: "@kampus/tuval-worktree/window",
		});
		expect(row.renderer).toBe(WORKTREE_WINDOW_REF);
	});

	it("gives every worktree program the same specifier, because one module answers them all", () => {
		expect(worktree({...options, id: "lane"}).renderer).toEqual(
			worktree({...options, id: "reviews"}).renderer,
		);
	});
});

/**
 * The consumer path, end to end and from outside: the fixture `.tuval/tuval.config.ts` beside this
 * package builds its rows through `@kampus/tuval-worktree`'s own entry and
 * `@kampus/tuval/sessions`, exactly as a user's config does. Nothing here boots a desk, spends a
 * token or touches git — the fixture's runner refuses everything.
 */
describe("a user's `.tuval/tuval.config.ts`", () => {
	it("builds a worktree row through the package's entry, with the id the graph node names", () => {
		expect(desk.id).toBe("worktree");
		expect(desk.label).toBe("worktree (claude-session)");
		expect(config.graph.nodes.map((node) => node.program)).toContain("worktree");
	});

	it("carries a second, named row beside it — one that only provisions", () => {
		expect(reviews.id).toBe("reviews");
		expect(reviews.label).toBe("reviews (tuval-worktree-fixture)");
		expect(reviews.args).toBeUndefined();
		expect(config.programs.map((row) => row.id)).toEqual(["worktree", "reviews"]);
	});

	it("carries the two in-ports the spells land on, and the two tile ports", () => {
		const ports = portsOf(desk);
		expect(ports.open?.direction).toBe("in");
		expect(ports.close?.direction).toBe("in");
		expect(Object.keys(ports)).toEqual(expect.arrayContaining([TITLE_PORT, STATUS_PORT]));
	});
});
