/**
 * The Email Sending IaC surface (ADR 0101) — the `send.kamp.us` sending
 * subdomain, declared production-only.
 *
 * Provisioning the subdomain auto-creates the DKIM/SPF/return-path DNS records
 * (kamp.us is on Cloudflare DNS, so they validate automatically and `enabled`
 * flips true). It is reputation-isolated on its own subdomain, and it is wasteful
 * + wrong to register one per ephemeral preview stage — so the stack yields this
 * ONLY for a production deploy (`provisionEmailSending`, gated on
 * `process.env.ENVIRONMENT`). dev/preview use the `EmailSenderLog` sink and never
 * touch the binding (see `email-sender.ts`).
 *
 * The `send_email` worker binding itself is not declared here: the production
 * adapter `bind()`s the `EmailSenderBinding` descriptor at worker init, and that
 * adapter is only selected under `ENVIRONMENT=production` — so the binding is
 * recorded for prod deploys and absent everywhere else, the same ENVIRONMENT gate
 * this subdomain is on.
 */
import {adopt} from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/** The apex zone — adopted (already on Cloudflare DNS), never created/deleted by the stack. */
export const KAMPUS_ZONE_NAME = "kamp.us" as const;

/** The reputation-isolated subdomain transactional mail is sent from. */
export const SENDING_SUBDOMAIN = "send.kamp.us" as const;

/**
 * Declare the kamp.us zone (adopted) + the `send.kamp.us` sending subdomain.
 * Yielded by the stack only on a production deploy.
 */
export const provisionEmailSending = Effect.gen(function* () {
	// Adopt the existing apex zone for its `zoneId`; a zone carries no ownership
	// markers, so alchemy refuses to take it over without `adopt(true)`. Zones
	// default to retain on removal — destroying the stack never deletes it.
	const zone = yield* Cloudflare.Zone("kampus_zone", {name: KAMPUS_ZONE_NAME}).pipe(adopt(true));
	const sending = yield* Cloudflare.EmailSendingSubdomain("phoenix_email_sending", {
		zoneId: zone.zoneId,
		name: SENDING_SUBDOMAIN,
	});
	return {zoneId: zone.zoneId, sendingEnabled: sending.enabled};
});

/**
 * Is this a production deploy? The stack runs at the alchemy CLI moment, so it
 * reads the deploy-time `process.env.ENVIRONMENT` (the same var the worker's
 * `effect/Config` binds at runtime). Fail-closed: anything but the explicit
 * `production` literal is treated as non-production, so a preview/dev deploy
 * never provisions the subdomain.
 */
export const isProductionDeploy = (env: {readonly ENVIRONMENT?: string | undefined}): boolean =>
	env.ENVIRONMENT === "production";
