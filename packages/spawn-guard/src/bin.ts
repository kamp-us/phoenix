/**
 * `spawn-guard` CLI — the two harness-event surfaces for issue #744.
 *
 *  - `node src/bin.ts guard` — a `PreToolUse` hook on Task/Workflow. It reads the
 *    Claude Code hook envelope on stdin (`tool_input.model`), resolves the
 *    `WORKFLOW_MODEL` pin from the env, and prints the `hookSpecificOutput`
 *    permission decision: **allow** an allowlisted model, **rewrite** an
 *    absent/disallowed model to the pin via `updatedInput.model`, or **deny** when
 *    neither the request nor the pin is on the allowlist. Per ADR 0092 it fails
 *    closed — an unset/unknown model is a `deny`, and the `systemMessage` always
 *    emits *what it checked* (the allowlist, the requested model, the pin).
 *
 *  - `node src/bin.ts statusline` — a `statusLine` command. It reads the statusLine
 *    payload on stdin (`cost.total_cost_usd`, token totals, model) and prints one
 *    compact per-session cost line to stdout (Claude Code renders stdout as the
 *    statusline). On an unparseable/empty payload it prints a stable placeholder, so
 *    a bad frame degrades to "cost n/a", never a crash that blanks the statusline.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/leak-guard`):
 * `effect/unstable/cli` subcommands, the Node platform over `NodeServices.layer`,
 * run via `NodeRuntime.runMain`.
 */
import {readFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {decideSpawn, formatSessionCost, type SessionCostInput} from "./spawn-guard.ts";

/**
 * Read all of stdin as a UTF-8 string (the hook/statusline JSON envelope). The harness
 * pipes the envelope on fd 0; a synchronous read of fd 0 mirrors `leak-guard`'s
 * `readFileSync` IO idiom and avoids a stream that hangs when run on a TTY with no pipe.
 * An empty/unreadable stdin yields `""` (the parser then degrades to `{}`).
 */
const readStdin = (): Effect.Effect<string> =>
	Effect.try({
		try: () => readFileSync(0, "utf8"),
		catch: () => "",
	}).pipe(Effect.orElseSucceed(() => ""));

const parseJson = (raw: string): Effect.Effect<Record<string, unknown>> =>
	Effect.try({
		try: () => (raw.trim().length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>)),
		catch: () => ({}),
	}).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" ? v : null);
const asRecord = (v: unknown): Record<string, unknown> =>
	v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};

const guard = Command.make(
	"guard",
	{},
	Effect.fn(function* () {
		const env = yield* readStdin().pipe(Effect.flatMap(parseJson));
		const toolInput = asRecord(env.tool_input);
		const requested = asString(toolInput.model);
		const pin = asString(process.env.WORKFLOW_MODEL ?? null);

		const decision = decideSpawn(requested, pin);

		switch (decision.kind) {
			case "allow":
				yield* Console.log(
					JSON.stringify({
						hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"},
						systemMessage: `spawn-guard: allow ${decision.model} — ${decision.checked}`,
					}),
				);
				return;
			case "rewrite":
				yield* Console.log(
					JSON.stringify({
						hookSpecificOutput: {
							hookEventName: "PreToolUse",
							permissionDecision: "allow",
							updatedInput: {...toolInput, model: decision.model},
						},
						systemMessage: `spawn-guard: pinned ${decision.from} → ${decision.model} (WORKFLOW_MODEL) — ${decision.checked}`,
					}),
				);
				return;
			case "deny":
				// ADR 0092: fail closed. An off-allowlist or unset model is a DENY, and the
				// reason emits what the guard checked so the refusal is observable, not silent.
				yield* Console.log(
					JSON.stringify({
						hookSpecificOutput: {
							hookEventName: "PreToolUse",
							permissionDecision: "deny",
							permissionDecisionReason: `spawn-guard: DENY — model ${decision.requested ?? "<unset>"} is not on the allowlist and no valid WORKFLOW_MODEL pin. ${decision.checked}`,
						},
						systemMessage: `spawn-guard: DENY off-allowlist/unset spawn model — ${decision.checked}`,
					}),
				);
				return;
		}
	}),
).pipe(
	Command.withDescription(
		"PreToolUse spawn-model allowlist guard (Task/Workflow), fail-closed (ADR 0092)",
	),
);

const statusline = Command.make(
	"statusline",
	{},
	Effect.fn(function* () {
		const payload = yield* readStdin().pipe(Effect.flatMap(parseJson));
		const cost = asRecord(payload.cost);
		const input: SessionCostInput = {
			totalCostUsd: asNumber(cost.total_cost_usd) ?? asNumber(payload.total_cost_usd),
			totalTokens:
				asNumber(cost.total_tokens) ??
				asNumber(payload.total_tokens) ??
				asNumber(asRecord(payload.usage).total_tokens),
			model: asString(asRecord(payload.model).id) ?? asString(payload.model),
		};
		yield* Console.log(formatSessionCost(input));
	}),
).pipe(Command.withDescription("statusLine per-session cost/token renderer"));

const cli = Command.make("spawn-guard").pipe(
	Command.withSubcommands([guard, statusline]),
	Command.withDescription(
		"Workflow-model pin + per-session cost statusline + fail-closed spawn-model allowlist guard (#744)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
