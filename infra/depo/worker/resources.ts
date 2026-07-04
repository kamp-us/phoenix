/**
 * Resource declarations the doorman stack (`doorman.ts`) ensures exist and the
 * worker (`worker/index.ts`) binds. Both resources already exist and are ADOPTED,
 * not owned by depo: R2 buckets and D1 databases carry no per-stack ownership tag,
 * so alchemy's `read` returns plain attrs and silently adopts an existing resource
 * of the same physical name (see `alchemy/src/AdoptPolicy.ts`) — declaring the same
 * `name` reuses it via the account-global state store (ADR 0057), no re-provision.
 *
 *   - `DepoBucket` — the SAME R2 bucket the read-path stack (#1969, `depo.ts`)
 *     provisions. The doorman only writes into it. The declaration is kept
 *     BYTE-FOR-BYTE consistent with `depo.ts` — same `name`, same `domains` — so
 *     the two stacks converge on identical desired state and a doorman deploy can
 *     never clear the `depo.kamp.us` custom domain the read stack owns (omitting
 *     `domains` here would reconcile it to "no domains", per `BucketProps.domains`).
 *   - `PasaportDb` — the web app's `phoenix_db` D1, where pasaport's better-auth
 *     `apiKey` table lives. Adopted read-only: NO `migrationsDir`, so the doorman
 *     never touches phoenix_db's schema — it borrows the credential store to answer
 *     one verify question and owns none of it (ADR 0144: depo stays dumb).
 */
import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The depo R2 bucket. Declared identically to `depo.ts` so the shared desired
 * state never drifts between the read stack and the doorman stack.
 */
export const DepoBucket = Cloudflare.R2.Bucket("depo", {
	name: "depo",
	domains: [{name: "depo.kamp.us"}],
});

/**
 * The web app's D1 (`phoenix_db`), adopted by name for read-only apiKey lookups.
 * No `migrationsDir`: phoenix_db's schema is owned by `apps/web`, never by depo.
 */
export const PasaportDb = Cloudflare.D1.Database("phoenix_db", {
	name: "phoenix_db",
});
