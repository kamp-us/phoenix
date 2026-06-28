/**
 * The divan access gate (#1287, epic #1202) — the capability framework's first
 * **disjunctive** gate (ADR 0107): the right to view the çaylak proving ground is
 * earned by EITHER yazar standing OR platform-moderation authority (collapse-to-allow,
 * mirroring `kunye/sandbox.ts`'s `currentSandboxViewer` probe shape).
 *
 * How the OR is modeled (so it reads as a real disjunction, NOT an
 * `if (tier === "yazar" || isMod)` bypass):
 *
 *   - {@link ViewDivan} is a generic `Capability.Class` — its discharge verb
 *     `.authorize(check)` mints ONE `Grant<ViewDivan>` when a boolean `check`
 *     passes. The disjunction lives in {@link standsInDivan}, the check it runs.
 *   - {@link standsInDivan} runs TWO genuine capability discharges through the real
 *     framework seams — {@link DivanStanding}`.require` (the divan's OWN yazar-floor
 *     `Level`: actor-match + agent-attenuation + `Kunye` standing read) and
 *     `Moderate.over(platform)` (the ReBAC `Relation` discharge over the
 *     `moderates` tuple) — each collapsed to a boolean (`Denied`/`RequiresLevel`
 *     → `false`) and OR-ed: allow if EITHER mints, deny otherwise.
 *
 * So the two axes keep their own real discharge logic; the gate is their union, and
 * the two proof types collapse into one `ViewDivan` grant the read requires in its R
 * channel (enforcement-by-R, ADR 0107 §3) — a divan read that forgets the gate is a
 * compile error, not a forgotten `if`.
 *
 * Denial is the invisible {@link Denied} (`UNAUTHORIZED`): a denied çaylak/visitor
 * cannot distinguish "not standing" from "not signed in" — the divan is a private
 * destination, like the moderation queue.
 */
import {Capability, type Principal, platform} from "@kampus/authz";
import {Effect} from "effect";
import {Denied, RequiresLevel} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {Moderate} from "../kunye/moderate.ts";
import {authorshipLadder} from "../kunye/standing.ts";

/** Read a principal's global account-level rank off the {@link Kunye} standing service. */
const standingOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.tierOf(principal.id));

/**
 * The divan's OWN yazar-standing right (ADR 0107 §2: one class = one right, the tag
 * IS the right). A `Capability.Level` floored at `yazar` over the same
 * {@link authorshipLadder}, read from {@link Kunye} — but named and owned by the
 * divan, so divan access no longer borrows the sözlük `OpenTerm` write-path right as
 * a yazar litmus. The two yazar-floored rights (sözlük `OpenTerm`, this) now move
 * independently: a later change to one floor leaves the other untouched.
 */
export class DivanStanding extends Capability.Level<DivanStanding>()("divan/DivanStanding", {
	scale: authorshipLadder,
	min: "yazar",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Divanda durmak için yazar olmalısın.", need: "yazar"}),
}) {}

/**
 * The disjunctive check: TRUE iff the current actor discharges the yazar-floor
 * {@link DivanStanding} capability OR holds `Moderate.over(platform)`. Each arm is a
 * real discharge whose denial (`RequiresLevel` / `Denied`) is collapsed to `false` —
 * the collapse-to-allow shape of `currentSandboxViewer`, here OR-ed across two axes.
 */
const standsInDivan = Effect.gen(function* () {
	const asYazar = yield* DivanStanding.require.pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false)),
	);
	if (asYazar) return true;
	return yield* Moderate.over(platform).pipe(
		Effect.as(true),
		Effect.catch(() => Effect.succeed(false)),
	);
});

/**
 * The divan-view right, discharged by EITHER axis (see module docblock). A generic
 * `Capability.Class` because the right is a union of two heterogeneous proofs —
 * neither a single `Level` floor nor a single `Relation` can express the OR, so the
 * disjunction is the `.authorize` check and the result is one collapsed grant.
 */
export class ViewDivan extends Capability.Class<ViewDivan>()("divan/ViewDivan", {
	deny: () => new Denied({message: "Divanı görmek için yazar ya da moderatör olmalısın."}),
}) {}

/**
 * Gate `body` behind divan access: discharge {@link ViewDivan} (the invisible
 * {@link Denied} on failure) and thread the resulting grant into `body`'s R channel
 * via `ViewDivan.provide`. So `body` reads `yield* ViewDivan` for the gate proof,
 * and "reading the divan without a grant" is a compile error — the same shape as
 * `requireModeration`, here over the disjunctive capability.
 */
export const requireDivanAccess = <A, E, R>(body: Effect.Effect<A, E, ViewDivan | R>) =>
	ViewDivan.authorize(standsInDivan).pipe(
		Effect.flatMap((grant) => body.pipe(ViewDivan.provide(grant))),
	);
