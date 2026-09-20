/**
 * The five personas in `examples/`, each loaded as a module the way a desk loads a config — and
 * then driven through the fake runner, so the commands each one *claims* to run are the commands it
 * actually issues.
 *
 * Nothing here runs git, docker, nix or psql. That is not a precaution, it is the design: every
 * example's `setup` and `teardown` reach `./provision.ts`, which is handed a `Runner`, and the one
 * it is handed here records instead of doing. A persona whose header says `dropdb --if-exists
 * app_$NAME` and whose config says something else fails a case below.
 *
 * **The plan is derived, never restated.** `planFor` below goes through `settle` → `freshRecord` →
 * `openPlan`/`closePlan`, which is the exact chain `worktree.ts`'s cells go through on their way
 * to a `worktree.provision`. An earlier version of this file rebuilt the path, the branch and the
 * env plan by hand; that is a suite that keeps passing while the program's own derivation drifts
 * under it — which is the one failure a persona suite exists to catch.
 */

import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import dockerConfig, {
	options as dockerOptions,
	worktrees as dockerRow,
} from "../examples/docker-compose.tuval.config.ts";
import fabrikaConfig, {
	options as fabrikaOptions,
	lanes as fabrikaRow,
} from "../examples/fabrika-lane.tuval.config.ts";
import nixConfig, {
	options as nixOptions,
	worktrees as nixRow,
} from "../examples/nix.tuval.config.ts";
import soloConfig, {
	options as soloOptions,
	worktrees as soloRow,
} from "../examples/solo-laptop.tuval.config.ts";
import postgresConfig, {
	options as postgresOptions,
	worktrees as postgresRow,
} from "../examples/web-app-postgres.tuval.config.ts";
import {fakeRunner} from "./fake-runner.ts";
import {
	type Machine,
	machineLayer,
	type ProvisionPlan,
	provision,
	type TeardownPlan,
	teardown,
} from "./provision.ts";
import type {Runner} from "./runner.ts";
import {closePlan, freshRecord, openPlan, settle, type WorktreeFill} from "./worktree.ts";

const TEMPLATE = "PORT=3000\nAPI_KEY=\n";

/** The real Effect program, with the recording fake provided as the `Machine` layer. */
const drive = <A>(runner: Runner, program: Effect.Effect<A, never, Machine>): Promise<A> =>
	Effect.runPromise(Effect.provide(program, machineLayer(runner)));

/**
 * What `:… open <name>` would provision for this example — through the program's own derivation,
 * so a change to `settle` or `freshRecord` moves these cases rather than slipping past them.
 */
const planFor = (options: WorktreeFill, name = "feature-x"): ProvisionPlan => {
	const settled = settle(options);
	return openPlan(settled, freshRecord(settled, name), []);
};

/** And what `:… close <name>` would tear down, by the same route. */
const teardownFor = (
	options: WorktreeFill,
	name = "feature-x",
	port: number | null = 5170,
): TeardownPlan => {
	const settled = settle(options);
	return closePlan(settled, {...freshRecord(settled, name), port}, false);
};

describe("the personas are read through the program's own derivation", () => {
	it("resolves the worktree, the branch and the env step the way `worktree(…)` does", () => {
		expect(planFor(soloOptions)).toEqual({
			name: "feature-x",
			repo: "/code/my-app",
			path: "/code/my-app/.worktrees/feature-x",
			branch: "can/feature-x",
			base: "origin/main",
			ports: {from: 5170, to: 5199},
			taken: [],
			env: {
				template: ".env.example",
				portKey: "PORT",
				vars: {},
				file: ".env",
			},
			setup: [],
		});
	});
});

describe("solo-laptop: a worktree, a free port, an .env — and nothing else", () => {
	it("is one program under the id the graph node names", () => {
		expect(soloRow.id).toBe("worktree");
		expect(soloRow.label).toBe("worktree (claude-session)");
		expect(soloConfig.graph.nodes).toEqual([{id: "worktree", program: "worktree", on: []}]);
	});

	it("runs no setup and no teardown at all, which is the persona", async () => {
		const runner = fakeRunner({
			files: {"/code/my-app/.env.example": TEMPLATE},
		});
		const outcome = await drive(runner, provision(planFor(soloOptions)));
		expect(outcome).toEqual({ok: true, port: 5170});
		expect(runner.commands()).toEqual([
			"git worktree add -b can/feature-x /code/my-app/.worktrees/feature-x origin/main",
		]);
		expect(runner.written.get("/code/my-app/.worktrees/feature-x/.env")).toBe(
			"PORT=5170\nAPI_KEY=\n",
		);
	});
});

describe("web-app-postgres: a scratch database per worktree", () => {
	it("is one program under the id the graph node names", () => {
		expect(postgresRow.id).toBe("worktree");
		expect(postgresConfig.programs).toHaveLength(1);
	});

	it("creates the database, installs and migrates — in that order, inside the worktree", async () => {
		const runner = fakeRunner({
			files: {"/code/my-app/.env.example": TEMPLATE},
		});
		await drive(runner, provision(planFor(postgresOptions)));
		expect(runner.commands()).toEqual([
			"git worktree add -b can/feature-x /code/my-app/.worktrees/feature-x origin/main",
			"createdb app_feature-x",
			"pnpm install",
			"pnpm db:migrate",
		]);
	});

	it("writes a DATABASE_URL that is this worktree's alone", async () => {
		const runner = fakeRunner({
			files: {"/code/my-app/.env.example": TEMPLATE},
		});
		await drive(runner, provision(planFor(postgresOptions)));
		expect(runner.written.get("/code/my-app/.worktrees/feature-x/.env")).toBe(
			"PORT=5170\nAPI_KEY=\nDATABASE_URL=postgres://localhost:5432/app_feature-x\n",
		);
	});

	it("drops that database on close, before the worktree goes — and does not force", async () => {
		const runner = fakeRunner();
		await drive(runner, teardown(teardownFor(postgresOptions)));
		expect(runner.commands()).toEqual([
			"dropdb --if-exists app_feature-x",
			"git worktree remove /code/my-app/.worktrees/feature-x",
		]);
	});
});

describe("docker-compose: a compose project per worktree", () => {
	it("is one program under the id the graph node names", () => {
		expect(dockerRow.id).toBe("worktree");
		expect(dockerConfig.version).toBe(1);
	});

	it("brings up a project named for the worktree, and takes it down with its volumes", async () => {
		const runner = fakeRunner({
			files: {"/code/my-stack/.env.example": "APP_PORT=3000\n"},
		});
		await drive(runner, provision(planFor(dockerOptions)));
		expect(runner.commands()).toContain("docker compose -p feature-x up -d --wait");
		// The published port lands in `.env`, which is where compose reads `${APP_PORT}` from.
		expect(runner.written.get("/code/my-stack/.worktrees/feature-x/.env")).toBe("APP_PORT=5170\n");

		const closing = fakeRunner();
		await drive(closing, teardown(teardownFor(dockerOptions)));
		expect(closing.commands()).toEqual([
			"docker compose -p feature-x down -v",
			"git worktree remove /code/my-stack/.worktrees/feature-x",
		]);
	});
});

describe("nix: the flake is the environment, so there is no env step", () => {
	it("is one program under the id the graph node names", () => {
		expect(nixRow.id).toBe("worktree");
		expect(nixConfig.programs).toHaveLength(1);
	});

	it("declares the env step away, and reads no template at all", async () => {
		expect(nixOptions.env).toBe(false);
		expect(planFor(nixOptions).env).toBeNull();
		const runner = fakeRunner();
		const outcome = await drive(runner, provision(planFor(nixOptions)));
		expect(outcome).toEqual({ok: true, port: 5170});
		expect(runner.calls.map((call) => call.kind)).toEqual(["exec", "portFree", "exec"]);
	});

	it("warms the dev shell in setup, and tells the session to use it", async () => {
		const runner = fakeRunner();
		await drive(runner, provision(planFor(nixOptions)));
		expect(runner.commands()).toContain("nix develop -c true");
		expect(nixOptions.brief).toContain("nix develop -c");
	});
});

describe("fabrika-lane: a worktree per lane, named for the issue", () => {
	it("is one program under the id the graph node names, which is `lane`", () => {
		expect(fabrikaRow.id).toBe("lane");
		expect(fabrikaConfig.graph.nodes).toEqual([{id: "lane", program: "lane", on: []}]);
	});

	it("puts issue 9287's worktree on `build/9287`, under `.lanes`", async () => {
		const runner = fakeRunner({
			files: {"/code/phoenix/.env.example": TEMPLATE},
		});
		await drive(runner, provision(planFor(fabrikaOptions, "9287")));
		expect(runner.commands()).toEqual([
			"git worktree add -b build/9287 /code/phoenix/.lanes/9287 origin/main",
			"pnpm install --frozen-lockfile",
		]);
	});

	it("gives two concurrent lanes two ports, which is the whole point of the persona", async () => {
		const runner = fakeRunner();
		const first = await drive(runner, provision({...planFor(fabrikaOptions, "9287"), env: null}));
		const second = await drive(
			runner,
			provision({
				...planFor(fabrikaOptions, "9288"),
				env: null,
				taken: first.ok ? [first.port] : [],
			}),
		);
		expect([first, second]).toEqual([
			{ok: true, port: 5170},
			{ok: true, port: 5171},
		]);
	});
});

describe("every persona, together", () => {
	it("builds a row and a graph node whose program id match", () => {
		for (const [config, row] of [
			[soloConfig, soloRow],
			[postgresConfig, postgresRow],
			[dockerConfig, dockerRow],
			[nixConfig, nixRow],
			[fabrikaConfig, fabrikaRow],
		] as const) {
			expect(config.programs.map((one) => one.id)).toEqual([row.id]);
			expect(config.graph.nodes.map((node) => node.program)).toEqual([row.id]);
			expect(row.renderer).toEqual({
				kind: "module",
				ref: "@kampus/tuval-worktree/window",
			});
		}
	});

	it("closes every one of them without --force, which is the no-data-loss default", () => {
		for (const options of [
			soloOptions,
			postgresOptions,
			dockerOptions,
			nixOptions,
			fabrikaOptions,
		]) {
			expect(teardownFor(options).force).toBe(false);
		}
	});
});
