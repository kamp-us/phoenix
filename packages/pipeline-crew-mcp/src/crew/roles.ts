/**
 * crew/roles — the kind-typed roster seam: the ONE place the concrete roster is named, as a
 * role → kind map. Everything else in `crew/` (catalog, wiring, tests) references `CrewRole`
 * / `CREW_ROLES` / `kindOf` and never a role string literal, so the roster changes here alone.
 *
 * The roster is a TYPE, not a slug list: cardinality falls out of the KIND (bridge → 1, engine
 * → N), so a bridge-with-cardinality-2 is unrepresentable. See ADR 0189.
 */
import {Schema} from "effect";

/**
 * A role's KIND governs its cardinality. A bridge owns a unique factory↔outside seam, so it is
 * singleton; an engine owns no seam and is fungible throughput, so it scales by count. See ADR 0189.
 */
export type CrewRoleKind = "bridge" | "engine";

/**
 * The standing roster's slugs — the enumeration surface every caller that iterates the roster
 * consumes (the total catalog, the `--role` flag choices, the wire schema). A definite tuple so
 * `Schema.Literals` / `Flag.choice` infer the precise `CrewRole` union and index access stays
 * total; `CREW_ROSTER` below kinds each of these entries.
 */
export const CREW_ROLES = [
	"chief-of-staff",
	"cartographer",
	"intake-desk",
	"engineering-manager",
] as const;

/** The Role enum as an `effect/Schema` literal union — decode-checks a role at the wire boundary. */
export const CrewRole = Schema.Literals(CREW_ROLES);
export type CrewRole = (typeof CREW_ROLES)[number];

/** A total refinement: is `value` one of the standing crew roles? */
export const isCrewRole = Schema.is(CrewRole);

/**
 * The kind-typed roster: three bridges + the engine pool — the single source of a role's KIND,
 * from which every kind/cardinality helper derives. `satisfies Record<CrewRole, CrewRoleKind>`
 * makes it TOTAL over the roster: add a role to `CREW_ROLES` without kinding it here and this
 * stops compiling. See ADR 0189.
 */
export const CREW_ROSTER = {
	"chief-of-staff": "bridge",
	cartographer: "bridge",
	"intake-desk": "bridge",
	"engineering-manager": "engine",
} as const satisfies Record<CrewRole, CrewRoleKind>;

/** Total: the kind of any crew role, read straight off the roster map. */
export const kindOf = (role: CrewRole): CrewRoleKind => CREW_ROSTER[role];

/**
 * A role's DRIVE governs how it STARTS — orthogonal to its kind (which governs cardinality). A
 * self-driving role runs a standing work loop under its own power, so it is autobooted on every
 * stand-up and takes a cold-start boot turn. A human-in-the-loop role has NO standing loop: it is an
 * on-demand, per-session partner a human spawns when they want it (the cartographer's charting
 * session), so it is never autobooted and, if launched, comes up idle waiting for the human rather
 * than confabulating work. See ADR 0189 (roster law) + #3524.
 */
export type CrewRoleDrive = "self-driving" | "human-in-the-loop";

/**
 * The drive of each roster role — the single source of which roles self-drive a standing loop.
 * `satisfies Record<CrewRole, CrewRoleDrive>` makes it TOTAL over the roster: add a role to
 * `CREW_ROLES` without kinding its drive here and this stops compiling. The cartographer is the one
 * human-in-the-loop role (a HITL ideation partner with nothing to autorun, #3524); the rest self-drive.
 */
export const CREW_DRIVE = {
	"chief-of-staff": "self-driving",
	cartographer: "human-in-the-loop",
	"intake-desk": "self-driving",
	"engineering-manager": "self-driving",
} as const satisfies Record<CrewRole, CrewRoleDrive>;

/** Total: the drive of any crew role, read straight off the roster map. */
export const driveOf = (role: CrewRole): CrewRoleDrive => CREW_DRIVE[role];

/**
 * Whether a role is autobooted on stand-up: exactly the self-driving roles. A human-in-the-loop role
 * is on-demand — spawned by a human when wanted — and is never part of the standing drain crew (#3524).
 */
export const isAutobooted = (role: CrewRole): boolean => driveOf(role) === "self-driving";

/**
 * Cardinality is a FUNCTION of kind, never a free field — a bridge is exactly one (nobody else
 * owns its seam), an engine is an unbounded pool (`"N"`). Because the only way to name a
 * cardinality is through the kind, a bridge with cardinality 2 does not typecheck. See ADR 0189.
 */
export type CardinalityOf<K extends CrewRoleKind> = K extends "bridge" ? 1 : "N";
export type CrewRoleCardinality = CardinalityOf<CrewRoleKind>;

const KIND_CARDINALITY = {
	bridge: 1,
	engine: "N",
} as const satisfies {readonly [K in CrewRoleKind]: CardinalityOf<K>};

/** The cardinality a given kind admits: `bridge` → `1`, `engine` → `"N"` (unbounded pool). */
export const cardinalityOfKind = <K extends CrewRoleKind>(kind: K): CardinalityOf<K> =>
	KIND_CARDINALITY[kind] as CardinalityOf<K>;

/** The cardinality a given role admits, derived through its kind. */
export const cardinalityOf = (role: CrewRole): CrewRoleCardinality =>
	KIND_CARDINALITY[kindOf(role)];
