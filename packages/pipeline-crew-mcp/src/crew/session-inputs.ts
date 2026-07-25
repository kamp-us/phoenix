/**
 * crew/session-inputs — resolve one crew session's launch inputs (role, project root, instance) from
 * either the CLI flag OR the process environment, fail-closed on an unresolvable role.
 *
 * Why an env source at all: the marketplace plugin channel (claude-plugins/pipeline-crew-mcp,
 * #3366 / ADR 0201) packages the crew server as ONE static `.mcp.json` entry so allowlist/production
 * mode can bind it via a `plugin:<name>@<marketplace>` ref. A static declaration cannot carry a
 * per-pane `--role`, because the one declaration serves every role while the role differs per
 * session — so under the plugin-channel launch path a session reads its role/project-root/instance
 * from the pane's environment (`CREW_ROLE`/`CREW_PROJECT_ROOT`/`CREW_INSTANCE`), which the launcher
 * sets per pane. The dev-mode `server:`-ref path is unchanged: it still passes `--role` on argv, and
 * the flag WINS over the env here, so the two launch paths coexist with no behavioral change to dev.
 *
 * The one non-obvious thing: role resolution FAILS CLOSED. Role is the one input with no safe default
 * (project-root falls back to cwd, instance is legitimately absent for a bridge), so an absent-and-
 * unset or an invalid role is a session to refuse with a named error, never a guessed role.
 */
import {Effect, Schema} from "effect";
import {CREW_ROLES, type CrewRole, isCrewRole} from "./roles.ts";

/** The pane-environment key a plugin-channel session reads its role from when `--role` is absent (#3366). */
export const CREW_ROLE_ENV = "CREW_ROLE";
/** The pane-environment key for the session's project root when `--project-root` is absent (falls back to cwd after this). */
export const CREW_PROJECT_ROOT_ENV = "CREW_PROJECT_ROOT";
/** The pane-environment key for an engine session's launcher-assigned instance when `--instance` is absent. */
export const CREW_INSTANCE_ENV = "CREW_INSTANCE";

/** The env shape the resolvers read — the three crew launch keys, each optionally set. */
export interface SessionInputEnv {
	readonly CREW_ROLE?: string | undefined;
	readonly CREW_PROJECT_ROOT?: string | undefined;
	readonly CREW_INSTANCE?: string | undefined;
}

/**
 * Neither `--role` nor a valid `$CREW_ROLE` resolved a crew role — the session is refused (fail-closed).
 * `attempted` is the raw env value seen (empty when unset) so the operator can tell "unset" from "typo".
 */
export class SessionRoleUnresolvedError extends Schema.TaggedErrorClass<SessionRoleUnresolvedError>()(
	"@kampus/pipeline-crew-mcp/crew/SessionRoleUnresolvedError",
	{
		attempted: Schema.String,
		validRoles: Schema.Array(Schema.String),
	},
) {}

/** Trim a possibly-undefined env value to a non-empty string, or `undefined` — so a blank env var reads as absent. */
const nonEmpty = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Resolve the session's role: the `--role` flag if present (dev-mode argv path, always wins), else
 * `$CREW_ROLE` validated against `CREW_ROLES` (plugin-channel env path), else fail closed. A present
 * flag is already a `CrewRole` (the CLI validated `Flag.choice`), so only the env branch re-validates.
 */
export const resolveSessionRole = (
	flagRole: CrewRole | undefined,
	env: SessionInputEnv,
): Effect.Effect<CrewRole, SessionRoleUnresolvedError> => {
	if (flagRole !== undefined) return Effect.succeed(flagRole);
	const fromEnv = nonEmpty(env.CREW_ROLE);
	if (fromEnv !== undefined && isCrewRole(fromEnv)) return Effect.succeed(fromEnv);
	return Effect.fail(
		new SessionRoleUnresolvedError({attempted: fromEnv ?? "", validRoles: CREW_ROLES}),
	);
};

/**
 * Resolve the session's project root: the `--project-root` flag if present, else `$CREW_PROJECT_ROOT`,
 * else the process cwd. Total — project-root always has a safe default (the repo the pane launched in),
 * so unlike role it never fails.
 */
export const resolveSessionProjectRoot = (
	flagProjectRoot: string | undefined,
	env: SessionInputEnv,
	cwd: string,
): string => flagProjectRoot ?? nonEmpty(env.CREW_PROJECT_ROOT) ?? cwd;

/**
 * Resolve the session's instance: the `--instance` flag if present, else `$CREW_INSTANCE`, else
 * `undefined`. Absent is a legitimate state (a bridge singleton, or a direct run) — `sessionInstance`
 * mints one — so this never fails; it only threads a launcher-assigned engine identity through.
 */
export const resolveSessionInstance = (
	flagInstance: string | undefined,
	env: SessionInputEnv,
): string | undefined => flagInstance ?? nonEmpty(env.CREW_INSTANCE);
