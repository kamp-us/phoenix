/**
 * `@kampus/spawn-guard` — the harness-config slice for issue #744: a `WORKFLOW_MODEL`
 * pin, per-session cost on the statusline, and a fail-closed spawn-model allowlist
 * guard. The core (`decideSpawn`, `formatSessionCost`, `isOnAllowlist`) is a pure,
 * IO-free decision; `bin.ts` wires it to the Claude Code `PreToolUse` and `statusLine`
 * envelopes as an Effect CLI (the `leak-guard` idiom). See ADR 0092 (fail-closed) and
 * ADR 0091 (the live fleet is the consumer).
 */
export {
	ALLOWLIST,
	decideSpawn,
	formatSessionCost,
	isOnAllowlist,
	type SessionCostInput,
	type SpawnDecision,
} from "./spawn-guard.ts";
