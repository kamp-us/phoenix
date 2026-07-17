/**
 * tracker/ — the control-plane registry: a standing `RpcServer` over a per-project unix socket
 * where peers announce their role + inbox, look each other up, and hold named role leases, all as
 * soft state that ages out on missed heartbeats. Registry only — it NEVER relays a message (that
 * is the peer/data-plane's job). Generic (crew-agnostic); see the boundary note in `../index.ts`.
 */
export {TrackerRegistry} from "./group.ts";
export {TrackerHandlers} from "./handlers.ts";
export {type AnnounceInput, Registry, RegistryLive} from "./registry.ts";
export {
	DEFAULT_TTL_SECONDS,
	type Lease,
	type PresenceRecord,
	type RegistryState,
} from "./registry-core.ts";
export {
	isTrackerAddressInUse,
	launchTracker,
	socketPathFor,
	trackerServerLayer,
} from "./server.ts";
