/**
 * The example's own tests, and the two that guard what makes it an example: its length, and the
 * packages it does not import. Both read the module's source text, because neither fact survives
 * compilation — a thirty-line program that grew to ninety still typechecks, and a cross-package
 * import is invisible in the compiled row.
 */

import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Schema, Stream} from "effect";
import {expect} from "vitest";
import config from "../../../.tuval/tuval.config.ts";
import {codexSession} from "../../codex/program.ts";
import {SpawnedProcesses} from "../../commands/core/process.ts";
import {buildRegistry, lookupRow} from "../../commands/registry.ts";
import {ClientId, type Scope, WorkspaceId} from "../../commands/spell.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {noSelfReport} from "../../process/self-report.ts";
import {type AnyProgram, ProgramId, programLabel} from "../../registry/program.ts";
import {emit, send, spawn} from "../effect.ts";
import {port} from "../port.ts";
import {ShapeMismatch} from "../shape.ts";
import {testProgram} from "../test-program.ts";
import {prReview, prReviewProgram} from "./pr-review.ts";

const source = readFileSync(resolve(import.meta.dirname, "pr-review.ts"), "utf8");

/** Everything below the top-of-file docblock, which is the text the line budget is over. */
const body = source.slice(source.indexOf("*/") + 2).split("\n");

/**
 * The reviewer the example is actually registered with: a *shipped* row, built the way
 * `.tuval/tuval.config.ts` builds it. `codexSession` composes its layer lazily, so the row exists
 * without the Codex CLI or any SDK behind it, and this is the row the structural check runs on —
 * not a fixture standing in for one (#8887).
 */
const codexReviewer = codexSession({
	cwd: "/tmp/tuval-pr-review-test",
	scope: {workspace: WorkspaceId.make("tuval/test"), client: ClientId.make("tuval/test")},
});

describe("authoring.example.pr-review is short enough to copy", () => {
	it("fits the thirty-line bar with five lines of slack (#8716 R11.1)", () => {
		// Leading and trailing blanks belong to the docblock's own spacing and the file's final
		// newline, so the count is the written body between them.
		const written = body.join("\n").trim().split("\n");
		expect(written.length).toBeLessThanOrEqual(35);
	});

	it("imports no program package, so no reviewer's SDK rides along", () => {
		const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "");
		expect(specifiers).not.toEqual([]);
		// Resolved, not prefix-matched: `../../codex/program.ts` starts with `../` too, and it is
		// exactly the cross-package import this criterion exists to forbid.
		//
		// Two roots are allowed, and the second is the one #8887 added. `src/authoring/` is the layer
		// the example is written in. `src/ai-agent/ports/` is the port vocabulary every Tuval agent
		// speaks: its own `boundary.unit.test.ts` holds it closed over `effect` and the kernel's
		// program row, so importing it drags in no agent implementation, and both ends naming one
		// payload is exactly what R15.1's structural check compares. What the criterion forbids is a
		// *program package* — `codex/`, `claude/`, `pi/`, `agy/`, `demo/`, `shell/` — and this still
		// refuses every one of them.
		const allowed = [
			resolve(import.meta.dirname, ".."),
			resolve(import.meta.dirname, "../../ai-agent/ports"),
		];
		const outside = specifiers.filter(
			(from) =>
				from !== "effect" &&
				!allowed.some((root) => resolve(import.meta.dirname, from).startsWith(`${root}/`)),
		);
		expect(outside).toEqual([]);
	});
});

describe("authoring.example.pr-review declares the whole shape the epic named", () => {
	it("two ports, one arg, one command and both derived lines", () => {
		expect(prReviewProgram.ports.pr.direction).toBe("in");
		expect(prReviewProgram.ports.verdict.direction).toBe("out");
		expect(Object.keys(prReviewProgram.args)).toEqual(["reviewer"]);
		expect(Object.keys(prReviewProgram.commands)).toEqual(["review"]);
		expect(prReviewProgram.title({pr: 8690, verdict: null})).toBe("pr-review #8690");
		expect(prReviewProgram.status({pr: 8690, verdict: "ship it"})).toBe("ship it");
	});
});

describe("authoring.example.pr-review, driven with testProgram", () => {
	it("asks for a spawn of the reviewer when a pull request arrives", () => {
		const run = testProgram(prReviewProgram).send("pr", 8690);
		expect(run.state.pr).toBe(8690);
		expect(run.effects).toContainEqual(
			spawn(prReviewProgram.args.reviewer, {on: {result: "result"}}),
		);
	});

	it("announces on `verdict` when the reviewer's routed `result` comes back", () => {
		const run = testProgram(prReviewProgram)
			.send("pr", 8690)
			.event({type: "result", payload: {text: "ship it", items: [], ok: true}});
		expect(run.state.verdict).toBe("ship it");
		expect(run.effects).toContainEqual(emit("verdict", "ship it"));
	});

	// The command names a bare port and no process at all: which process of `pr-review` it lands on
	// is resolved where the call lands (`../own-process.ts`, #8898), so the scope is beside the
	// point here and the case below is the one that proves the payload reaches a process.
	it("composes the `review` command's send at its own program's `pr` port", () => {
		const run = testProgram(prReviewProgram).call("review", 8690);
		expect(run.effects).toEqual([send("pr", 8690)]);
	});

	it("reaches the process: the compiled spell puts the payload on a live `pr-review`'s `pr` port", () => {
		const sent: Array<readonly [ProcessId, string, unknown]> = [];
		const live = ProcessId.make("proc-pr-review");
		const row = prReview({reviewer: codexReviewer});
		const review = (row.spells ?? []).find((spell) => spell.path.join(".") === "review");
		if (review === undefined) throw new Error("the example declares no `review` spell");
		const scope: Scope = {
			workspace: WorkspaceId.make("tuval/test"),
			client: ClientId.make("tuval/test"),
		};
		// `AnySpell` erases the spell's requirements, so the two layers below are what discharge them
		// and the cast is where that obligation is spent — the same one `../../commands/executor.ts`
		// describes at the composition root.
		const call = review.execute(8690, scope) as Effect.Effect<
			void,
			unknown,
			SpawnedProcesses | ProcessTable
		>;
		Effect.runSync(
			Effect.provide(call, [
				Layer.succeed(
					SpawnedProcesses,
					SpawnedProcesses.of({
						send: (process, port, payload) =>
							Effect.sync(() => {
								sent.push([process, port, payload]);
								return {delivered: true, evicted: 0};
							}),
						spawn: () => Effect.die("a command cannot reach spawn"),
						ask: () => Effect.die("a command cannot reach ask"),
						answer: () => Effect.die("a command cannot reach answer"),
						read: () => Effect.die("a command cannot reach read"),
					}),
				),
				Layer.succeed(
					ProcessTable,
					ProcessTable.of({
						list: Effect.succeed([
							{
								id: live,
								programId: ProgramId.make("pr-review"),
								parentId: Option.none(),
								ports: {},
								stateSummary: () => ({lifecycle: "running", revision: 0, state: null}),
								selfReport: () => noSelfReport,
							},
						]),
						get: () => Effect.die("unused"),
						changes: Stream.empty,
					}),
				),
			]),
		);
		expect(sent).toEqual([[live, "pr", 8690]]);
	});
});

describe("authoring.example.pr-review, registered", () => {
	it("resolves `:pr-review review` and shows the shipped reviewer it was handed", () => {
		const row = prReview({reviewer: codexReviewer});
		const table = Effect.runSync(buildRegistry({core: [], programs: [row]}));
		expect(lookupRow(table, ["pr-review", "review"])).toBeDefined();
		expect(programLabel(row)).toBe(`pr-review (${codexReviewer.id})`);
	});

	it("refuses a reviewer whose `prompt` carries the wrong payload, naming the port and side", () => {
		// A row that declares both ports the shape names, with the in-side payload a caller would
		// plausibly guess at — a bare line rather than the stamped turn `prompt` carries. The refusal
		// lands at the config call, which is the whole point of typing the fill by its ports (#8887).
		const wrong = {
			id: "wrong-reviewer",
			ports: {prompt: port.in(Schema.String), result: port.out(Schema.String)},
		};
		const refuse = () => prReview({reviewer: wrong});
		expect(refuse).toThrow(ShapeMismatch);
		// The message is the refusal's whole content, and it carries all four: which arg was filled,
		// which program filled it, which port did not fit and on which side.
		expect(refuse).toThrow(
			/arg "reviewer" is filled with program "wrong-reviewer", whose in-port "prompt" does not fit the declared shape: the program's "prompt" carries a different payload/,
		);
	});

	it("is absent from the booted config while its flag is off", () => {
		// The config layer's own block, not `featuresDefault`: that block is what gates the row, and a
		// row is built before boot has a merged record to read (#8595, ADR 0375).
		expect(config.features?.prReviewExample).toBe(false);
		const ids = config.programs.map((row) => (row as AnyProgram).id);
		expect(ids).not.toContain("pr-review");
		expect(config.graph.nodes.map((node) => node.program)).not.toContain("pr-review");
	});
});
