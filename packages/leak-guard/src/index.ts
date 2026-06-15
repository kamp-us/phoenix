/**
 * `@phoenix/leak-guard` — the write-time enforcement of the repo's no-local-paths
 * rule for shared-artifact doc surfaces (issue #173). The core (`findLeaks` and
 * its surface predicates) is a pure, IO-free matcher; `bin.ts` wires it to the
 * Claude Code PreToolUse envelope as an Effect CLI. This is the mechanical guard
 * that replaces per-skill prose reminders (the failure mode behind #158).
 */
export {findLeaks, isSelfExempt, isSharedArtifact, type Leak} from "./leak-guard.ts";
