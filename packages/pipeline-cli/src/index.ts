/**
 * @kampus/pipeline-cli — the subcommand-router home all pipeline tooling folds
 * into (epic #994). Phase 1 (issue #996) ships the shell: the registry seam, the
 * pure router core, and one tracer tool (`version`).
 *
 * The public surface a Phase-2 child touches is `registry.ts` (append your tool's
 * `Command` to `registeredTools`); the router core and bin are consumed opaquely.
 */
export {type RegisteredTool, registeredTools} from "./registry.ts";
export {dispatch, NoToolError, toolNames, UnknownToolError} from "./router.ts";
export {VERSION, versionCommand} from "./version.ts";
