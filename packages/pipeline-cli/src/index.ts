/**
 * @kampus/pipeline-cli — the subcommand-router home all pipeline tooling folds
 * into (epic #994). Phase 1 (issue #996) ships the shell: the registry seam, the
 * pure router core, and one tracer tool (`version`).
 *
 * The public surface a Phase-2 child touches is `registry.ts` (append your tool's
 * `tool(<name>, () => import(<module>))` row to `registeredTools`); the router core
 * and bin are consumed opaquely.
 */
export {registeredTools} from "./registry.ts";
export {dispatch, type NamedTool, NoToolError, toolNames, UnknownToolError} from "./router.ts";
export {
	type LoadedRegistry,
	loadRegistration,
	loadRegistry,
	type RegisteredTool,
	ToolLoadError,
	type ToolLoadFailure,
	type ToolRegistration,
	tool,
} from "./tool-registration.ts";
export {VERSION, versionCommand} from "./version.ts";
