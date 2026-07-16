/**
 * crew/roles — the crew's flat-topology Role enum: the ONE place the concrete role roster
 * is named, so the catalog, the wiring, and the tests reference `CrewRole` / `CREW_ROLES`
 * and never a role string literal. The roster below is the single swap-in seam — nothing
 * else in `crew/` hardcodes a role, so the set can change without reworking anything.
 *
 * The roster is a founder ruling (five standing roles, not four); the slugs are the repo's
 * canonical agent-type identifiers, so a crew role maps 1:1 to the agent-type that fills it.
 */
import {Schema} from "effect";

/**
 * The five standing crew roles, canonical agent-type slugs. Flat topology: every role is a
 * symmetric peer on the substrate — any role may claim, hand off, tally, ping, and discover
 * any other. This tuple is the roster seam; see the module note.
 */
export const CREW_ROLES = [
	"ea-chief-of-staff",
	"engineering-manager",
	"triage-guy",
	"junior-engineer",
	"cartographer",
] as const;

/** The Role enum as an `effect/Schema` literal union — decode-checks a role at the wire boundary. */
export const CrewRole = Schema.Literals(CREW_ROLES);
export type CrewRole = typeof CrewRole.Type;

/** A total refinement: is `value` one of the standing crew roles? */
export const isCrewRole = Schema.is(CrewRole);
