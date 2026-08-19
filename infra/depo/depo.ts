/**
 * The depo read-path stack — an R2 bucket served publicly with zero compute over
 * the `depo.kamp.us` custom domain (ADR 0144: depo is kampus's internal asset
 * store / CDN, dumb by mandate).
 *
 * Read path only: attaching the custom domain with public access enabled IS the read seam, and
 * there is nothing else to serve (ADR 0144 decision 3). The write path (the doorman upload worker)
 * and the `depo` CLI are separate slices of epic #1965.
 *
 * A public-read custom domain is FORCED and bounds what depo may hold: anything
 * embeddable in a GitHub PR/issue must be anonymously fetchable (GitHub's Camo
 * proxy can't authenticate), so `depo.kamp.us/<sha256>.<ext>` is capability-URL
 * security — unguessable, but readable by anyone holding the URL. depo (for the
 * GitHub-embed path) must never hold read-sensitive assets (ADR 0144).
 *
 * Own stack, own deploy cycle — NOT a route on `apps/web`, NOT an `apps/` worker (ADR 0144
 * decision 2, ADR 0057). Deploy is a manual `pnpm --filter @kampus/depo-infra deploy:depo`; wiring
 * it into CI deploy automation is a separate follow-up.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
	"depo",
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		// Stable, unprefixed bucket name: this is a single long-lived CDN bucket, not
		// a per-stage app resource, so the read URL must stay fixed across deploys.
		// The custom domain's `enabled` defaults to `true` → public read; the zone
		// (`kamp.us`) is inferred from the hostname. This is the entire read path.
		yield* Cloudflare.R2.Bucket("depo", {
			name: "depo",
			domains: [{name: "depo.kamp.us"}],
		});
	}),
);
