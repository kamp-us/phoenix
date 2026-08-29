/**
 * The depth floor the fabrika shells need, and the one function that applies it.
 *
 * opencode's task tool refuses a spawn once the calling session's parent chain is already
 * `subagent_depth` deep (`packages/opencode/src/tool/task.ts`, read at v1.18.21). The operator
 * spawned by a primary agent sits at depth 1 and every route in its loop is a spawn of another
 * shell, so a host repo left on opencode's default of 1 registers all eight shells and can still
 * dispatch nothing (#6980).
 */
export const FABRIKA_SUBAGENT_DEPTH = 2;

export const raiseSubagentDepth = (configured: number | undefined): number =>
	Math.max(configured ?? 1, FABRIKA_SUBAGENT_DEPTH);
