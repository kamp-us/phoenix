/**
 * standup/ — the launcher: boot the whole crew from the operator config. This barrel is the module's
 * one public surface, re-exporting every launcher primitive and the `runStandUp` orchestration that
 * composes them in order (version-assert → ensure-tracker → roster session-set → per-session bind →
 * tmux placement → launch), fail-loud with no partial crew (epic #3237, issue #3299).
 */
export {
	ALLOWLIST_CHANNEL_FLAG,
	buildSessionBind,
	ChannelPluginNotAllowedError,
	CREW_SESSION_BIN_PATH,
	CREW_SESSION_COMMAND,
	CrewServerNotRegisteredError,
	CrewSessionBinUnresolvableError,
	DEV_CHANNEL_FLAG,
	MCP_CONFIG_FLAG,
	type SessionBind,
	type SessionBindInput,
} from "./bind.ts";
export {
	CHANNEL_PLUGIN_REF_RE,
	CHANNEL_SERVER_REF_RE,
	ChannelConfig,
	ChannelMode,
	ChannelServerRef,
	CLI_VERSION_RE,
	CliVersion,
	DEFAULT_CONFIG_PATH,
	decodeLaunchConfig,
	EngineCount,
	LaunchConfig,
	LaunchConfigError,
	parseJsonc,
	readLaunchConfig,
	resolveConfigPath,
	stripJsonc,
} from "./config.ts";
export {
	ensureTrackerRunning,
	runStandingTracker,
	type TrackerBindOutcome,
	type TrackerHandle,
	TrackerNotServingError,
	tryBecomeTracker,
} from "./ensure-tracker.ts";
export {
	CREW_WINDOW,
	ensureNamedTmuxSession,
	FALLBACK_TMUX_SESSION,
	type LaunchedSession,
	type LaunchPlan,
	launchSessionInTmux,
	resolveTargetTmuxSession,
	runStandUp,
	type StandUpError,
	type StandUpInput,
	StandUpLaunchError,
	type StandUpResult,
	type TmuxRun,
	type TmuxRunner,
	TmuxSessionEnsureError,
} from "./orchestrate.ts";
export {
	type BridgeSession,
	type CrewSession,
	deriveSessionSet,
	type EngineSession,
	type SessionSetInput,
} from "./session-set.ts";
export {
	computeTmuxPlacement,
	type PlacementTarget,
	type RosterSession,
	TmuxPaneCollisionError,
} from "./tmux-placement.ts";
export {
	assertPinnedCliVersion,
	CliVersionAssertError,
	parseCliVersion,
	readInstalledCliVersionOutput,
} from "./version-assert.ts";
