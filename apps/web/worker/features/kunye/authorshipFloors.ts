/**
 * The standing floor per authorship right — the one declaration `Authorship.ts`'s
 * `Capability.Level` instances take their `min` from (ADR 0107 §4).
 *
 * It lives outside `Authorship.ts` because the client reads these floors too (#7044's
 * capability-aware nudge) and `Authorship.ts` pulls `Kunye` → `Pasaport` → drizzle,
 * which cannot enter the browser bundle. Declaring the floors here rather than copying
 * them client-side is what makes a client/server drift unrepresentable instead of
 * merely tested.
 */
import {authorshipLadder, type Tier} from "./standing.ts";

/** Keyed by each capability's own id, so a floor and its `Capability.Level` cannot be paired wrong. */
export const AUTHORSHIP_FLOORS = {
	"kunye/OpenTerm": "yazar",
	"kunye/AddEntry": "çaylak",
} as const satisfies Record<string, Tier>;

export type AuthorshipRight = keyof typeof AUTHORSHIP_FLOORS;

/** Whether an account at `tier` clears a right's declared floor. */
export function holdsAuthorshipRight(tier: Tier, right: AuthorshipRight): boolean {
	return authorshipLadder.gte(tier, AUTHORSHIP_FLOORS[right]);
}
