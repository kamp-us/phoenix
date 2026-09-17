/**
 * Provisioning, driven against the recording fake — no git, no port bind, no disk.
 *
 * The first case is the one that matters most and reads as the least: the order of the four steps.
 * It is asserted as a list because a reordering is silent — an `.env` written before the worktree
 * exists fails on a machine and passes in a reviewer's head.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fakeRunner } from "./fake-runner.ts";
import {
  DETAIL_LIMIT,
  type Machine,
  machineLayer,
  type ProvisionPlan,
  pickPort,
  provision,
  reconcile,
  rewriteEnv,
  safeDetail,
  substitute,
  teardown,
} from "./provision.ts";
import type { Runner } from "./runner.ts";

/**
 * Every case drives the real Effect program with the recording fake provided as the `Machine`
 * layer. That is the whole adaptation: the assertions below are the ones this suite always made —
 * the order as a list, the step each failure names, what reconcile asks and never does.
 */
const drive = <A>(
  runner: Runner,
  program: Effect.Effect<A, never, Machine>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(program, machineLayer(runner)));

const plan = (over: Partial<ProvisionPlan> = {}): ProvisionPlan => ({
  name: "feature-x",
  repo: "/repo",
  path: "/repo/.workspaces/feature-x",
  branch: "can/feature-x",
  base: "origin/main",
  ports: { from: 5170, to: 5175 },
  taken: [],
  env: {
    template: ".env.example",
    portKey: "PORT",
    vars: {},
    file: ".env",
  },
  setup: ["pnpm install"],
  ...over,
});

const TEMPLATE = "# the app\nPORT=3000\nAPI_KEY=\n";

describe("open, step by step", () => {
  it("does worktree, then port, then env, then setup — and never another order", async () => {
    const runner = fakeRunner({ files: { "/repo/.env.example": TEMPLATE } });
    const outcome = await drive(runner, provision(plan()));
    expect(outcome).toEqual({ ok: true, port: 5170 });
    expect(runner.calls.map((call) => call.kind)).toEqual([
      "exec", // git worktree add
      "portFree", // the probe
      "read", // the template
      "write", // the .env
      "exec", // pnpm install
    ]);
  });

  it("cuts the worktree from the declared base, on the declared branch", async () => {
    const runner = fakeRunner({ files: { "/repo/.env.example": TEMPLATE } });
    await drive(runner, provision(plan()));
    expect(runner.calls[0]).toEqual({
      kind: "exec",
      command:
        "git worktree add -b can/feature-x /repo/.workspaces/feature-x origin/main",
      cwd: "/repo",
    });
  });

  it("runs setup inside the worktree, never in the repository it was cut from", async () => {
    const runner = fakeRunner({ files: { "/repo/.env.example": TEMPLATE } });
    await drive(
      runner,
      provision(plan({ setup: ["pnpm install", "pnpm db:migrate"] })),
    );
    const setup = runner.calls.filter(
      (call) => call.kind === "exec" && call.command.startsWith("pnpm"),
    );
    expect(setup).toEqual([
      {
        kind: "exec",
        command: "pnpm install",
        cwd: "/repo/.workspaces/feature-x",
      },
      {
        kind: "exec",
        command: "pnpm db:migrate",
        cwd: "/repo/.workspaces/feature-x",
      },
    ]);
  });

  it("stops at the step that failed and says which one it was", async () => {
    const runner = fakeRunner({
      files: { "/repo/.env.example": TEMPLATE },
      failing: { "pnpm install": "ERR_PNPM_LOCKFILE" },
    });
    const outcome = await drive(
      runner,
      provision(plan({ setup: ["pnpm install", "pnpm build"] })),
    );
    expect(outcome).toEqual({
      ok: false,
      step: "setup",
      detail: "pnpm install: ERR_PNPM_LOCKFILE",
      // The compensation records rather than deletes: the half-built tree is kept, named, and is
      // what `:workspace close <name>` later removes.
      kept: "/repo/.workspaces/feature-x",
    });
    // And the step after it never ran, which is the half a "first failure wins" claim is about.
    expect(runner.commands()).not.toContain("pnpm build");
  });

  it("names the worktree step when git refuses, and touches nothing else", async () => {
    const runner = fakeRunner({
      failing: {
        "git worktree add -b can/feature-x /repo/.workspaces/feature-x origin/main":
          "fatal: 'can/feature-x' already exists",
      },
    });
    const outcome = await drive(runner, provision(plan()));
    expect(outcome).toEqual({
      ok: false,
      step: "worktree",
      detail: "fatal: 'can/feature-x' already exists",
      // Nothing was built, so there is nothing to keep — the release never ran.
      kept: null,
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("names the env step when the template is not where the config said", async () => {
    const runner = fakeRunner();
    const outcome = await drive(runner, provision(plan()));
    expect(outcome).toEqual({
      ok: false,
      step: "env",
      detail: "no env template at .env.example",
      kept: "/repo/.workspaces/feature-x",
    });
  });

  it("names the env step when the write itself was refused, and keeps the tree", async () => {
    const runner = fakeRunner({
      files: { "/repo/.env.example": TEMPLATE },
      unwritable: {
        "/repo/.workspaces/feature-x/.env": "EROFS: read-only file system",
      },
    });
    const outcome = await drive(runner, provision(plan()));
    expect(outcome).toEqual({
      ok: false,
      step: "env",
      detail:
        "could not write /repo/.workspaces/feature-x/.env: EROFS: read-only file system",
      kept: "/repo/.workspaces/feature-x",
    });
    // And `setup` never ran: a refused write short-circuits the rest by construction.
    expect(runner.commands()).toEqual([
      "git worktree add -b can/feature-x /repo/.workspaces/feature-x origin/main",
    ]);
  });

  it("skips the env step entirely for a config that declared none", async () => {
    const runner = fakeRunner();
    const outcome = await drive(runner, provision(plan({ env: null })));
    expect(outcome).toEqual({ ok: true, port: 5170 });
    expect(runner.calls.map((call) => call.kind)).toEqual([
      "exec",
      "portFree",
      "exec",
    ]);
  });
});

describe("the port probe", () => {
  it("skips a port the OS refuses and takes the next one", async () => {
    const runner = fakeRunner({ busy: [5170, 5171] });
    expect(await drive(runner, pickPort({ from: 5170, to: 5175 }, []))).toBe(
      5172,
    );
    expect(runner.calls.map((call) => call.kind)).toEqual([
      "portFree",
      "portFree",
      "portFree",
    ]);
  });

  it("skips a port this program already handed out without asking the OS at all", async () => {
    // The OS would say yes: the dev server inside that workspace has not started yet. Which is
    // exactly the race the `taken` list exists to close, so the probe is never even reached.
    const runner = fakeRunner();
    expect(
      await drive(runner, pickPort({ from: 5170, to: 5175 }, [5170, 5171])),
    ).toBe(5172);
    expect(runner.calls).toEqual([{ kind: "portFree", port: 5172 }]);
  });

  it("answers nothing when the whole range is spoken for", async () => {
    const runner = fakeRunner({ busy: [5170, 5171] });
    expect(
      await drive(runner, pickPort({ from: 5170, to: 5171 }, [])),
    ).toBeNull();
  });

  it("fails the provision on an exhausted range, naming the range", async () => {
    const runner = fakeRunner({ busy: [5170, 5171] });
    const outcome = await drive(
      runner,
      provision(plan({ ports: { from: 5170, to: 5171 } })),
    );
    expect(outcome).toEqual({
      ok: false,
      step: "port",
      detail: "no free port in 5170-5171",
      kept: "/repo/.workspaces/feature-x",
    });
  });
});

describe("the env file", () => {
  it("replaces the port key in place and leaves every other line alone", () => {
    expect(rewriteEnv(TEMPLATE, [["PORT", "5174"]])).toBe(
      "# the app\nPORT=5174\nAPI_KEY=\n",
    );
  });

  it("appends a key the template does not set, rather than guessing at a commented one", () => {
    const template = "# DATABASE_URL=postgres://localhost/example\nPORT=3000\n";
    expect(
      rewriteEnv(template, [
        ["PORT", "5174"],
        ["DATABASE_URL", "postgres://localhost/app_x"],
      ]),
    ).toBe(
      "# DATABASE_URL=postgres://localhost/example\nPORT=5174\nDATABASE_URL=postgres://localhost/app_x\n",
    );
  });

  it("finds a key the template exported", () => {
    expect(rewriteEnv("export PORT=3000\n", [["PORT", "5174"]])).toBe(
      "PORT=5174\n",
    );
  });

  it("is written into the worktree, never into the repository", async () => {
    const runner = fakeRunner({ files: { "/repo/.env.example": TEMPLATE } });
    await drive(runner, provision(plan()));
    expect([...runner.written.keys()]).toEqual([
      "/repo/.workspaces/feature-x/.env",
    ]);
  });

  it("resolves $NAME and $PORT in a declared var before writing it", async () => {
    const runner = fakeRunner({ files: { "/repo/.env.example": TEMPLATE } });
    await drive(
      runner,
      provision(
        plan({
          env: {
            template: ".env.example",
            portKey: "PORT",
            file: ".env",
            vars: {
              DATABASE_URL: "postgres://localhost:5432/app_$NAME",
              PUBLIC_URL: "http://localhost:$PORT",
            },
          },
        }),
      ),
    );
    expect(runner.written.get("/repo/.workspaces/feature-x/.env")).toBe(
      "# the app\nPORT=5170\nAPI_KEY=\nDATABASE_URL=postgres://localhost:5432/app_feature-x\nPUBLIC_URL=http://localhost:5170\n",
    );
  });
});

describe("the four substitutions", () => {
  const vars = {
    NAME: "feature-x",
    PORT: "5174",
    WORKTREE: "/repo/.workspaces/feature-x",
    BRANCH: "can/feature-x",
  };

  it("resolves each one, bare and braced", () => {
    expect(substitute("createdb app_$NAME", vars)).toBe(
      "createdb app_feature-x",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the braced form is the thing under test
    const braced = "serve --port ${PORT}";
    expect(substitute(braced, vars)).toBe("serve --port 5174");
    expect(substitute("cd $WORKTREE", vars)).toBe(
      "cd /repo/.workspaces/feature-x",
    );
    expect(substitute("git push -u origin $BRANCH", vars)).toBe(
      "git push -u origin can/feature-x",
    );
  });

  it("leaves a variable it does not own for the shell", () => {
    expect(substitute("echo $HOME $NAMESPACE", vars)).toBe(
      "echo $HOME $NAMESPACE",
    );
  });

  it("leaves $PATH alone, because the worktree is $WORKTREE and PATH is the shell's", () => {
    // The whole reason for the rename. `PATH=$PATH:./bin` is a thing people write in a setup line,
    // and while `$PATH` meant the worktree it silently became `PATH=/repo/.workspaces/x:./bin` —
    // a corrupted search path, with no `$PATH` ever reaching the shell to expand.
    expect(substitute("PATH=$PATH:./bin pnpm build", vars)).toBe(
      "PATH=$PATH:./bin pnpm build",
    );
    expect(substitute("echo $WORKTREE", vars)).toBe(
      "echo /repo/.workspaces/feature-x",
    );
  });

  it("leaves $$ for the shell too, now that nothing here needs escaping", () => {
    // `$$` was an escape only because `$PATH` was taken. With `$WORKTREE` there is nothing here to
    // escape, so `$$` reaches the shell as the shell's own — the process id.
    expect(substitute("echo $$", vars)).toBe("echo $$");
  });

  it("resolves the same variables in setup commands", async () => {
    const runner = fakeRunner({ files: { "/repo/.env.example": TEMPLATE } });
    await drive(
      runner,
      provision(plan({ setup: ["docker compose -p $NAME up -d --wait"] })),
    );
    expect(runner.commands()).toContain(
      "docker compose -p feature-x up -d --wait",
    );
  });
});

describe("close", () => {
  const closing = {
    name: "feature-x",
    repo: "/repo",
    path: "/repo/.workspaces/feature-x",
    branch: "can/feature-x",
    port: 5174,
    force: false,
  };

  it("runs teardown first, then removes the worktree", async () => {
    const runner = fakeRunner();
    const outcome = await drive(
      runner,
      teardown({
        ...closing,
        commands: [
          "dropdb --if-exists app_$NAME",
          "docker compose -p $NAME down -v",
        ],
      }),
    );
    expect(outcome).toEqual({ ok: true });
    expect(runner.calls).toEqual([
      {
        kind: "exec",
        command: "dropdb --if-exists app_feature-x",
        cwd: "/repo/.workspaces/feature-x",
      },
      {
        kind: "exec",
        command: "docker compose -p feature-x down -v",
        cwd: "/repo/.workspaces/feature-x",
      },
      {
        kind: "exec",
        command: "git worktree remove /repo/.workspaces/feature-x",
        cwd: "/repo",
      },
    ]);
  });

  it("refuses the removal when a teardown command failed", async () => {
    // Deliberate: a `dropdb` that did not work means the database is still there, and removing the
    // worktree on top of that deletes the only thing that knows which database it was.
    const runner = fakeRunner({
      failing: {
        "dropdb --if-exists app_feature-x": "database is being accessed",
      },
    });
    const outcome = await drive(
      runner,
      teardown({ ...closing, commands: ["dropdb --if-exists app_$NAME"] }),
    );
    expect(outcome).toEqual({
      ok: false,
      stage: "teardown",
      detail: "dropdb --if-exists app_feature-x: database is being accessed",
    });
    expect(
      runner.commands().some((one) => one.startsWith("git worktree remove")),
    ).toBe(false);
  });

  it("removes with no teardown commands at all, which is most configs", async () => {
    const runner = fakeRunner();
    expect(await drive(runner, teardown({ ...closing, commands: [] }))).toEqual(
      { ok: true },
    );
    expect(runner.commands()).toEqual([
      "git worktree remove /repo/.workspaces/feature-x",
    ]);
  });

  it("reports a removal git refused, so the record does not silently vanish", async () => {
    const runner = fakeRunner({
      failing: {
        "git worktree remove /repo/.workspaces/feature-x":
          "fatal: not a working tree",
      },
    });
    expect(await drive(runner, teardown({ ...closing, commands: [] }))).toEqual(
      { ok: false, stage: "remove", detail: "fatal: not a working tree" },
    );
  });
});

describe("the removal, and the work it will not throw away", () => {
  const closing = {
    name: "feature-x",
    repo: "/repo",
    path: "/repo/.workspaces/feature-x",
    branch: "can/feature-x",
    port: 5174,
    commands: [],
  };

  const DIRTY =
    "fatal: '/repo/.workspaces/feature-x' contains modified or untracked files, use --force to delete it";

  it("asks git without --force, so a dirty worktree is refused rather than deleted", async () => {
    const runner = fakeRunner({
      failing: { "git worktree remove /repo/.workspaces/feature-x": DIRTY },
    });
    const outcome = await drive(runner, teardown({ ...closing, force: false }));
    // Git's own words, so the record can say why rather than only "close failed".
    expect(outcome).toEqual({ ok: false, stage: "remove", detail: DIRTY });
    expect(runner.commands()).toEqual([
      "git worktree remove /repo/.workspaces/feature-x",
    ]);
  });

  it("passes --force only when the plan asked for it, which only `discard` does", async () => {
    const runner = fakeRunner();
    expect(await drive(runner, teardown({ ...closing, force: true }))).toEqual({
      ok: true,
    });
    expect(runner.commands()).toEqual([
      "git worktree remove /repo/.workspaces/feature-x --force",
    ]);
  });

  it("still refuses the removal outright when a teardown command failed, forced or not", async () => {
    const runner = fakeRunner({
      failing: { "dropdb app_feature-x": "database is being accessed" },
    });
    const outcome = await drive(
      runner,
      teardown({
        ...closing,
        commands: ["dropdb app_$NAME"],
        force: true,
      }),
    );
    expect(outcome).toMatchObject({ ok: false, stage: "teardown" });
    expect(
      runner.commands().some((one) => one.startsWith("git worktree remove")),
    ).toBe(false);
  });
});

describe("a failing command's output, before it is checkpointed", () => {
  it("redacts the credentials out of a URL, keeping the host that names the problem", () => {
    expect(
      safeDetail(
        "fatal: could not read from https://ci:hunter2@git.example.com/x.git",
      ),
    ).toBe("fatal: could not read from https://***:***@git.example.com/x.git");
  });

  it("redacts a SECRET/TOKEN/PASSWORD assignment, keeping which variable it was", () => {
    expect(
      safeDetail(
        "env: NPM_TOKEN=npm_abc123 DB_PASSWORD=hunter2 API_SECRET = s3cr3t PORT=5174",
      ),
    ).toBe("env: NPM_TOKEN=*** DB_PASSWORD=*** API_SECRET=*** PORT=5174");
  });

  it("leaves output with nothing secret-shaped in it exactly as it was", () => {
    expect(safeDetail("ERR_PNPM_LOCKFILE: lockfile is out of date")).toBe(
      "ERR_PNPM_LOCKFILE: lockfile is out of date",
    );
  });

  it("bounds it, and says the cut happened rather than stopping mid-word", () => {
    const cut = safeDetail("x".repeat(DETAIL_LIMIT + 200));
    expect(cut).toHaveLength(DETAIL_LIMIT + "… (truncated)".length);
    expect(cut.endsWith("… (truncated)")).toBe(true);
  });

  it("is what a failed setup command's detail actually carries", async () => {
    const runner = fakeRunner({
      files: { "/repo/.env.example": TEMPLATE },
      failing: {
        "pnpm install":
          "npm ERR! 401 https://ci:hunter2@registry.example.com/ (NPM_TOKEN=npm_abc123)",
      },
    });
    const outcome = await drive(runner, provision(plan()));
    expect(outcome).toEqual({
      ok: false,
      step: "setup",
      detail:
        "pnpm install: npm ERR! 401 https://***:***@registry.example.com/ (NPM_TOKEN=***)",
      kept: "/repo/.workspaces/feature-x",
    });
  });
});

describe("reconcile", () => {
  it("names the recorded workspaces whose directory is not there", async () => {
    const runner = fakeRunner({ dirs: ["/repo/.workspaces/kept"] });
    expect(
      await drive(
        runner,
        reconcile([
          { name: "kept", path: "/repo/.workspaces/kept" },
          { name: "removed", path: "/repo/.workspaces/removed" },
        ]),
      ),
    ).toEqual(["removed"]);
  });

  it("asks only, and never removes anything", async () => {
    const runner = fakeRunner();
    await drive(
      runner,
      reconcile([{ name: "a", path: "/repo/.workspaces/a" }]),
    );
    expect(runner.calls.every((call) => call.kind === "exists")).toBe(true);
  });
});
