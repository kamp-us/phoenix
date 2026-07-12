export * from "./bash-attribution.ts";
// The read-only log IO — re-exported so a consumer wiring run-time attribution (the §CP
// `worktree-guard pre-bash` leg) writes through the SAME best-effort, never-throw log append and
// out-of-repo default path the pre-commit `record` bin uses (no second log surface).
export {appendRecord, defaultLogPath, detectPrimaryCheckout} from "./git-io.ts";
export * from "./tripwire.ts";
