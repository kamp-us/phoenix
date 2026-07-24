/**
 * crew/ — the only crew-coupled module: the Role enum, the seam catalog, and the wiring that
 * binds the generic substrate (`protocol`/`tracker`/`peer`/`edge`) to the concrete crew
 * topology. Depends inward on the generic modules; the generic core never depends back on it
 * (the one-way boundary in `../index.ts`, guarded by `./boundary.test.ts`).
 */
export {
	ALL_SEAMS,
	type CrewCatalogEntry,
	CrewCatalogGroup,
	type CrewSeamName,
	CrewSeams,
	crewCatalog,
	seamsFor,
} from "./catalog.ts";
export {
	type CrewChannel,
	type CrewChannelConfig,
	crewSocketDialerLayer,
	inboxServerSocketLayer,
	inboxSocketPathFor,
	makeCrewChannel,
} from "./channel-server.ts";
export {
	type ChannelContract,
	type RoleContract,
	resolveChannelContract,
	roleContract,
	roleContracts,
	type SeamContract,
} from "./contract.ts";
export {RoleUniquenessError} from "./errors.ts";
export {
	type CrewSessionProc,
	collectLiveRegisteredAddresses,
	INIT_PID,
	isOrphanedCrewServer,
	type OrphanDiscriminationInput,
	type ProcessEntry,
	type ProcessReaper,
	type ProcessSnapshot,
	ProcessSnapshotError,
	parseCrewSessionProc,
	parseProcessTable,
	productionProcessReaper,
	productionProcessSnapshot,
	REAP_SIGNAL,
	type ReapOrphansInput,
	type ReapOutcome,
	type ReapReport,
	type ReapSignalOutcome,
	reapOrphanedCrewServers,
} from "./reaper.ts";
export {
	type CardinalityOf,
	CREW_DRIVE,
	CREW_ROLES,
	CREW_ROSTER,
	CrewRole,
	type CrewRoleCardinality,
	type CrewRoleDrive,
	type CrewRoleKind,
	cardinalityOf,
	cardinalityOfKind,
	driveOf,
	isAutobooted,
	isCrewRole,
	kindOf,
} from "./roles.ts";
export {
	type CrewSessionConfig,
	channelSendFromPeer,
	crewSessionLayer,
	inboxAddressFor,
	inboxSocketFor,
	runCrewSession,
	SESSION_SERVER_NAME,
} from "./session.ts";
export {
	type ClaimReply,
	CrewTracker,
	crewTrackerHostOrDialLayer,
	crewTrackerSocketLayer,
	peerTrackerLayer,
	type TrackerRegistryClient,
} from "./tracker.ts";
