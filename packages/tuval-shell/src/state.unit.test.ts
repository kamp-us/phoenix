/**
 * The leaf, on its own: the two lines a tile draws and the bound an output is cut to. Pure
 * functions over plain records — no program, no child process, no kernel.
 */

import { describe, expect, it } from "vitest";
import {
  basename,
  boundedTail,
  byteLength,
  commandHead,
  droppedNote,
  type ShellRun,
  type ShellState,
  statusLine,
  succeeded,
  titleLine,
} from "./state.ts";

const idle: ShellState = {
  id: "shell",
  cwd: "/Users/can/phoenix",
  running: null,
  last: null,
};

const request = {
  key: "k1",
  command: "git fetch --all",
  startedAt: 1_700_000_000_000,
};

const ran = (run: Partial<ShellRun>): ShellState => ({
  ...idle,
  last: {
    ...request,
    ending: { _tag: "exit", code: 0 },
    durationMs: 1_234,
    ...run,
  },
});

describe("what a shell calls itself", () => {
  it("titles itself by its id and the basename of where it runs", () => {
    expect(titleLine(idle)).toBe("shell · phoenix");
    expect(titleLine({ ...idle, id: "fetcher", cwd: "/tmp/" })).toBe(
      "fetcher · tmp",
    );
  });

  it("keeps the root readable rather than calling it the empty string", () => {
    expect(basename("/")).toBe("/");
  });
});

describe("what a shell says it is doing", () => {
  it("says `idle` before anything has been asked of it", () => {
    expect(statusLine(idle)).toBe("idle");
  });

  it("names the command while one is up", () => {
    expect(statusLine({ ...idle, running: request })).toBe(
      "running git fetch --all",
    );
  });

  it("elides a command too long for a tile, and takes only its first line", () => {
    const long = "x".repeat(80);
    expect(commandHead(long)).toHaveLength(40);
    expect(commandHead(long).endsWith("…")).toBe(true);
    expect(commandHead("make build\nmake test")).toBe("make build");
  });

  it("reports the exit code and how long it took", () => {
    expect(statusLine(ran({}))).toBe("exit 0 in 1.2s");
    expect(statusLine(ran({ ending: { _tag: "exit", code: 1 } }))).toBe(
      "exit 1 in 1.2s",
    );
  });

  it("tells a timeout, a kill and a restart apart, because they are three different failures", () => {
    expect(statusLine(ran({ ending: { _tag: "timeout" } }))).toBe(
      "timed out after 1.2s",
    );
    expect(statusLine(ran({ ending: { _tag: "killed" } }))).toBe(
      "killed after 1.2s",
    );
    expect(
      statusLine(ran({ ending: { _tag: "interrupted" }, durationMs: 0 })),
    ).toBe("interrupted by restart");
  });

  it("calls exactly one ending a success, and it is a zero exit", () => {
    const run = (ending: ShellRun["ending"]): ShellRun => ({
      ...request,
      ending,
      durationMs: 1,
    });
    expect(succeeded(run({ _tag: "exit", code: 0 }))).toBe(true);
    expect(succeeded(run({ _tag: "exit", code: 1 }))).toBe(false);
    expect(succeeded(run({ _tag: "timeout" }))).toBe(false);
    expect(succeeded(run({ _tag: "killed" }))).toBe(false);
    expect(succeeded(run({ _tag: "interrupted" }))).toBe(false);
  });
});

describe("bounding an output", () => {
  it("leaves an output that fits exactly as it was", () => {
    expect(boundedTail("hi\n", 64)).toBe("hi\n");
  });

  it("keeps the tail, not the head — the last line is the one that says what happened", () => {
    const bounded = boundedTail("aaaaaaaaaa\nboom\n", 6);
    expect(bounded.endsWith("boom\n")).toBe(true);
    expect(bounded).toContain("bytes of earlier output dropped");
  });

  it("says how much it dropped rather than lying about being whole", () => {
    const bounded = boundedTail("x".repeat(100), 10);
    expect(bounded).toBe(`${droppedNote(90)}${"x".repeat(10)}`);
  });

  it("cuts on a code-point boundary, so the kept tail is readable text", () => {
    // Six three-byte characters; a bound of ten bytes cannot land on a boundary by luck.
    const bounded = boundedTail("日本語日本語", 10);
    expect(bounded).not.toContain("�");
    expect(bounded.endsWith("本語")).toBe(true);
  });

  it("adds what an earlier window already lost to the same note, not a second one", () => {
    const bounded = boundedTail("x".repeat(100), 10, 5_000);
    expect(bounded).toBe(`${droppedNote(5_090)}${"x".repeat(10)}`);
    expect(bounded.match(/dropped/g)).toHaveLength(1);
  });

  it("still says so when nothing needed cutting but something was already lost", () => {
    expect(boundedTail("tail\n", 64, 12)).toBe(`${droppedNote(12)}tail\n`);
  });

  it("counts bytes and not characters, which is the only honest unit for a bound", () => {
    expect(byteLength("日")).toBe(3);
    expect(byteLength("abc")).toBe(3);
  });
});
