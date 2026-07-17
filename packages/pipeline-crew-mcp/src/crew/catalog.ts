/**
 * crew/catalog — where the abstract protocol message kinds (`../protocol/`) become the
 * concrete crew seams, and each role is mapped to the seams it is a party to.
 *
 * The value-add over the raw protocol: the two distinct crew uses of the one `Claim` kind
 * are named apart — `claimCollisionCheck` (an agent claiming an issue before picking it up)
 * and `roleUniquenessLease` (a session claiming its ROLE so only one holds it) both ride
 * `Claim` on the wire, keyed by resource vs role respectively. Flat topology: every role is
 * a party to every seam, so the catalog is a total map over `CREW_ROLES` — swap the roster
 * and the catalog follows, no per-role special-casing to update.
 */
import {
	AnnouncePresence,
	Claim,
	CrewProtocol,
	DrainProgress,
	Heartbeat,
	IntakePing,
	LookupRole,
	Release,
} from "../protocol/index.ts";
import {CREW_ROLES, type CrewRole} from "./roles.ts";

/**
 * The named crew seams, each mapped to the protocol `Rpc` it rides. `claimCollisionCheck`
 * and `roleUniquenessLease` deliberately share `Claim` — same wire kind, two crew meanings;
 * `releaseClaim` is the resource claim's free counterpart (ADR 0191 facet 3).
 */
export const CrewSeams = {
	claimCollisionCheck: Claim,
	roleUniquenessLease: Claim,
	releaseClaim: Release,
	drainTally: DrainProgress,
	intakePing: IntakePing,
	announcePresence: AnnouncePresence,
	lookupRole: LookupRole,
	heartbeat: Heartbeat,
} as const;

export type CrewSeamName = keyof typeof CrewSeams;

/** Every named crew seam — the seam set every role is a party to under the flat topology. */
export const ALL_SEAMS = Object.keys(CrewSeams) as ReadonlyArray<CrewSeamName>;

/** The `RpcGroup` a crew peer speaks — the full protocol catalog the crew composes over. */
export const CrewCatalogGroup = CrewProtocol;

export interface CrewCatalogEntry {
	readonly role: CrewRole;
	/** The crew seams this role is a party to (flat topology ⇒ all of them). */
	readonly seams: ReadonlyArray<CrewSeamName>;
}

/** The catalog: a total map from each standing role to the seams it participates in. */
export const crewCatalog: ReadonlyMap<CrewRole, CrewCatalogEntry> = new Map(
	CREW_ROLES.map((role): readonly [CrewRole, CrewCatalogEntry] => [role, {role, seams: ALL_SEAMS}]),
);

/** The seams a role is a party to — total over the roster (never a missing entry). */
export const seamsFor = (role: CrewRole): ReadonlyArray<CrewSeamName> =>
	crewCatalog.get(role)?.seams ?? ALL_SEAMS;
