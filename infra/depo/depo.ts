/**
 * The depo read-path stack — an R2 bucket served publicly with zero compute over
 * the `depo.kamp.us` custom domain (ADR 0144: depo is kampus's internal asset
 * store / CDN, dumb by mandate).
 *
 * Read path only: objects live in the R2 bucket and are fetched anonymously at
 * `https://depo.kamp.us/<sha256>.<ext>` straight off R2 — no worker sits in the
 * read path (ADR 0144 decision 3). Attaching the custom domain with public access
 * enabled IS the read seam; there is nothing else to serve. The write path (the
 * doorman upload worker) and the `depo` CLI are separate slices of epic #1965.
 *
 * A public-read custom domain is FORCED and bounds what depo may hold: anything
 * embeddable in a GitHub PR/issue must be anonymously fetchable (GitHub's Camo
 * proxy can't authenticate), so `depo.kamp.us/<sha256>.<ext>` is capability-URL
 * security — unguessable, but readable by anyone holding the URL. depo (for the
 * GitHub-embed path) must never hold read-sensitive assets (ADR 0144).
 *
 * Own stack, own deploy cycle — NOT a route on `apps/web`, NOT an `apps/` worker
 * (ADR 0144 decision 2; the `infra/ci-credentials` standalone-stack precedent,
 * ADR 0057). Deploy is a scripted/manual `pnpm --filter @kampus/depo-infra
 * deploy:depo`, reusing the account-global alchemy state store + the CI Cloudflare
 * secrets — no second bootstrap (ADR 0057). Wiring it into CI deploy automation
 * touches `.github/**` (control-plane) and is a separate follow-up, out of scope.
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
