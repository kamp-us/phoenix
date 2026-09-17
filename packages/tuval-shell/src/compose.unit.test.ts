/**
 * The case this package exists for.
 *
 * `@kampus/tuval-cron` was authored against the *AI-agent* port pair: its `jobShape` is
 * `PromptPayloadSchema` in, `TurnResultSchema` out, and until now the only things that fitted it
 * were `claudeSession` and `codexSession`. `shell` is not an AI and has never heard of one — and it
 * fits, because `Program.shape` compares payload schemas and never asks what is behind them.
 *
 * So the assertion below is small on purpose: `cron({…, job: shell({…})})` *returns*. `defineProgram`
 * runs the fill and throws on a job that does not fit `jobShape`, so a call that returns is the fit.
 * Nothing here boots a desk, ticks a timer or runs a command: a row is a record.
 */

import { cron, jobShape } from "@kampus/tuval-cron";
import {
  PromptPayloadSchema,
  TurnResultSchema,
} from "@kampus/tuval/ai-agent/ports";
import {
  type AuthoredProgram,
  Program,
  testProgram,
} from "@kampus/tuval/authoring";
import { describe, expect, it } from "vitest";
import config, { nightlyFetch } from "../.tuval/tuval.config.ts";
import {
  type ShellOptions,
  type ShellPorts,
  type ShellUpdate,
  shell,
  shellProgram,
} from "./shell.ts";
import type { ShellState } from "./state.ts";

/**
 * The authored record under `testProgram`. The cast is `testProgram`'s signature and not this
 * program's — it predates `defineProgram`'s `X` (#9294) — and `shell.unit.test.ts` says so at
 * length.
 */
const drive = (options: ShellOptions) =>
  testProgram(
    shellProgram(options) as unknown as AuthoredProgram<
      ShellState,
      ShellPorts,
      ShellUpdate
    >,
  );

describe("a shell fills a cron's job", () => {
  it("is accepted as the job — the row fits `jobShape`, which is the whole point", () => {
    expect(() =>
      cron({
        everyMs: null,
        prompt: "printf hi",
        job: shell({ cwd: "/tmp" }),
      }),
    ).not.toThrow();
  });

  it("puts the shell on the cron's fill, so a tick spawns *this* shell", () => {
    const row = cron({
      everyMs: null,
      prompt: "printf hi",
      job: shell({ cwd: "/tmp" }),
    });
    expect(row.args).toEqual({ job: "tuval/arg/cron/job" });
    expect(row.label).toBe("cron (shell)");
  });

  it("fits the shape the AI-agent ports declare, not a copy of it", () => {
    // Both halves, from the interface module itself — the same schemas `shell`'s ports are declared
    // over. The day either side restates a payload instead of importing it, this stops being true.
    expect(jobShape).toEqual(
      Program.shape({
        in: { prompt: PromptPayloadSchema },
        out: { result: TurnResultSchema },
      }),
    );
    const ports = shell({ cwd: "/tmp" }).ports;
    expect(ports.prompt?.schema).toBe(PromptPayloadSchema);
    expect(ports.result?.schema).toBe(TurnResultSchema);
  });

  it("refuses a job that does not fit, so the fit above is a check and not a coincidence", () => {
    expect(() =>
      cron({
        everyMs: null,
        prompt: "printf hi",
        job: { id: "not-a-job", ports: {} },
      }),
    ).toThrow();
  });

  it("sends a prompt the shell's own port admits, which is the seam in one line", () => {
    const woken = drive({ cwd: "/tmp" }).send("prompt", {
      text: "git -C ~/phoenix fetch --all",
      key: "nightly-fetch-1",
      timestamp: 1_700_000_000_000,
    });
    expect(woken.state.running?.command).toBe("git -C ~/phoenix fetch --all");
  });
});

/**
 * The consumer path as a file: `.tuval/tuval.config.ts` beside this package is a real user config,
 * imported here and read back, so the README's pairing example is checked rather than claimed.
 */
describe("a user's `.tuval/tuval.config.ts`", () => {
  it("builds the nightly fetch through both packages' public entries", () => {
    expect(nightlyFetch.id).toBe("nightly-fetch");
    expect(nightlyFetch.label).toBe("nightly-fetch (shell)");
    expect(config.programs.map((row) => row.id)).toEqual(["nightly-fetch"]);
    expect(config.graph.nodes.map((node) => node.program)).toEqual([
      "nightly-fetch",
    ]);
  });
});
