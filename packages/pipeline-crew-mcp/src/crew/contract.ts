/**
 * crew/contract — the crew composition of the discoverable channel contract (#3622): the generic
 * kind→shape map (`../protocol/describe`) joined with each role's sanctioned seams (`./catalog`),
 * so a peer can resolve BOTH "what does kind K look like" and "which kinds may role R send/receive"
 * from one surface, ahead of any send.
 *
 * The role half is read straight off `seamsFor` / `CrewSeams`, so a future non-flat topology (a role
 * mapped to a seam subset instead of `ALL_SEAMS`) flows through automatically — never a hand-kept
 * second list. The kind half is `resolveKindContracts`, which fails loud if the shared kind set is
 * not fully resolvable (the startup invariant); this module threads that failure up so a session
 * refuses to serve an unresolvable contract.
 */
import {Effect} from "effect";
import {
	type ChannelContractError,
	type KindContract,
	resolveKindContracts,
} from "../protocol/index.ts";
import {type CrewSeamName, CrewSeams, seamsFor} from "./catalog.ts";
import {CREW_ROLES, type CrewRole} from "./roles.ts";

/** One seam a role is a party to, resolved to the wire kind it rides. */
export interface SeamContract {
	readonly seam: CrewSeamName;
	readonly kind: string;
}

/** A role's sanctioned send/receive seams, sourced from the catalog (so a non-flat topology stays in sync). */
export interface RoleContract {
	readonly role: CrewRole;
	readonly seams: ReadonlyArray<SeamContract>;
}

/** The full discoverable channel contract: the shared kind→shape map + each role's sanctioned seams. */
export interface ChannelContract {
	readonly kinds: ReadonlyArray<KindContract>;
	readonly roles: ReadonlyArray<RoleContract>;
}

/** The seams `role` is a party to, each resolved to the wire kind it rides (via `CrewSeams`). */
export const roleContract = (role: CrewRole): RoleContract => ({
	role,
	seams: seamsFor(role).map((seam) => ({seam, kind: CrewSeams[seam]._tag})),
});

/** Every standing role's seam contract — the role half of the discoverable surface, straight off the catalog. */
export const roleContracts = (): ReadonlyArray<RoleContract> => CREW_ROLES.map(roleContract);

/**
 * Resolve the full discoverable channel contract, or fail loud — the startup invariant (#3622). The
 * kind→shape map must resolve for EVERY shared kind before a session serves it; each role's seams are
 * read off the catalog. A session wires this on its boot critical path, so an unresolvable kind set
 * aborts the build rather than surfacing as a gap at first send.
 */
export const resolveChannelContract = (): Effect.Effect<ChannelContract, ChannelContractError> =>
	resolveKindContracts().pipe(Effect.map((kinds) => ({kinds, roles: roleContracts()})));
