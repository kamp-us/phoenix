/**
 * The `spawn-guard` tool — `pipeline-cli spawn-guard <guard|statusline|freshness>`.
 *
 * The harness-config slice for issue #744 (ADR 0092), moved into the pipeline-cli
 * registry (epic #994, Phase 2 / #998). Three harness-event surfaces:
 *
 *   - `guard`      — a PreToolUse hook on Task/Workflow. Reads the hook envelope on
 *     stdin (`tool_input.model`), resolves the `WORKFLOW_MODEL` pin from the env (an
 *     absent pin falls back to the committed `DEFAULT_PIN`, ADR 0116), and renders the
 *     `decideSpawn` outcome as a permission decision: **allow** an allowlisted model,
 *     **allow** an unset request to inherit the session model (#776/#943), or **deny**
 *     an off-allowlist request. Per ADR 0092 it still fails closed on a *present* bad
 *     model, and the `systemMessage` always emits *what it checked*.
 *   - `statusline` — a statusLine command. Reads the statusLine payload on stdin
 *     and prints one compact per-session cost line (Claude Code renders stdout as
 *     the statusline). An unparseable payload prints a stable placeholder.
 *   - `freshness`  — a SessionStart freshness check (#835): when the hook-pack's
 *     runtime dep is unresolvable the whole pack is degraded until `pnpm install`
 *     runs, so it emits a `SessionStart` `additionalContext` + a loud stderr note
 *     and exits 2; on a healthy tree it stays silent (exit 0, no output).
 *
 * `guard`/`statusline` handlers are byte-identical to the former package's
 * `bin.run.ts`; `freshness` reproduces the former `freshness-bin.ts` exit-2 /
 * additionalContext contract. The package's #777 stale-tree shim (`bin.ts` /
 * `preflight.ts`) is otherwise dropped: the `pipeline-cli` bin imports
 * `@effect/platform-node` statically, so by the time `guard`/`statusline` run the
 * runtime dep is always resolved. `freshness` keeps its own dep-resolution probe —
 * detecting the stale tree IS its whole job, and it must run before any dep is
 * imported, so the probe is `createRequire`-based (pure; imports nothing).
 */
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
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
			case "allow-inherit":
				yield* Console.log(
					JSON.stringify({
						hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"},
						systemMessage: `spawn-guard: allow unset (inherit session model; ${decision.defaulted ? "committed default pin" : "WORKFLOW_MODEL pin"} ${decision.pin} on allowlist) — ${decision.checked}`,
					}),
				);
				return;
			case "deny":
				// ADR 0092: fail closed. An off-allowlist or unset model is a DENY, and the
				// reason emits what the guard checked so the refusal is observable, not silent.
				// `explicitOffAllowlist` (an explicit bad model the pin can't override, #776)
				// gets a sharper reason than the no-valid-pin fail-closed default.
				yield* Console.log(
					JSON.stringify(
						decision.explicitOffAllowlist
							? {
									hookSpecificOutput: {
										hookEventName: "PreToolUse",
										permissionDecision: "deny",
										permissionDecisionReason: `spawn-guard: DENY — explicit model ${decision.requested} is not on the allowlist. ${decision.checked}`,
									},
									systemMessage: `spawn-guard: DENY explicit off-allowlist model ${decision.requested} — ${decision.checked}`,
								}
							: {
									hookSpecificOutput: {
										hookEventName: "PreToolUse",
										permissionDecision: "deny",
										permissionDecisionReason: `spawn-guard: DENY — model ${decision.requested ?? "<unset>"} is not on the allowlist and no valid WORKFLOW_MODEL pin. ${decision.checked}`,
									},
									systemMessage: `spawn-guard: DENY off-allowlist/unset spawn model — ${decision.checked}`,
								},
					),
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

/** The runtime dep whose absence on a not-yet-installed tree degrades the whole hook pack. */
const RUNTIME_DEP = "@effect/platform-node";

/** Is `dep` resolvable from here? `false` ⇒ stale `node_modules` (pre-`pnpm install`). */
const depsInstalled = (dep: string = RUNTIME_DEP): boolean => {
	try {
		createRequire(import.meta.url).resolve(dep);
		return true;
	} catch {
		return false;
	}
};

/**
 * The proactive SessionStart freshness signal (#835): when the hook-pack's runtime dep
 * is unresolvable the whole pack is degraded until `pnpm install` runs. Returns `null`
 * when deps resolve — a healthy session gets NO output. The string is the
 * `additionalContext` body the SessionStart hook hands the agent so it can tell the
 * user to run `pnpm install`.
 */
const freshnessSignal = (dep: string = RUNTIME_DEP): string | null =>
	depsInstalled(dep)
		? null
		: `Hook deps not installed — run \`pnpm install\`. The phoenix hook-pack's runtime ` +
			`dep (\`${dep}\`) is unresolvable, so the read-guard / worktree-guard / spawn-guard ` +
			`hooks are DEGRADED (not enforcing) and the statusline is a placeholder, until deps ` +
			`are installed (issue #835). Tell the user to run \`pnpm install\` from the repo root.`;

const freshness = Command.make(
	"freshness",
	{},
	Effect.fn(function* () {
		const signal = freshnessSignal();
		if (signal === null) return; // healthy tree → silent (exit 0, no output)
		yield* Console.log(
			JSON.stringify({
				hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: signal},
			}),
		);
		// exit 2 ⇒ stderr is shown to the user; SessionStart continues regardless.
		return yield* Effect.sync(() => {
			process.stderr.write(`spawn-guard: ${signal}\n`);
			process.exit(2);
		});
	}),
).pipe(
	Command.withDescription("SessionStart freshness check: surface a stale hook-pack tree (#835)"),
);

export const spawnGuardCommand = Command.make("spawn-guard").pipe(
	Command.withSubcommands([guard, statusline, freshness]),
	Command.withDescription(
		"Workflow-model pin + per-session cost statusline + fail-closed spawn-model allowlist guard (#744)",
	),
);
