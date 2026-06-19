/**
 * `@kampus/worktree-guard` — the harness slice that keeps an `isolation:worktree`
 * subagent's file/Bash tooling pinned to its worktree and reaps the worktree clean
 * when the agent exits (issue #741). Four pure, IO-free cores + a thin Effect bin
 * (`bin.ts`) that wires them to the Claude Code `PreToolUse` / `SubagentStop` hook
 * envelopes — the `epic-ledger`/`leak-guard` idiom (CLAUDE.md: never a `.py` hook).
 */
export {type BashDecision, hasLeadingCd, pinBash} from "./bash-pin.ts";
export {type EnterDecision, guardEnterWorktree} from "./enter-guard.ts";
export {mainCheckoutPrefix, type PathDecision, resolvePath} from "./path-resolve.ts";
export {decideReap, isManagedWorktree, type ReapDecision} from "./reap.ts";
