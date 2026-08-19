/**
 * The Email Sending IaC surface (ADR 0101) — the `send.kamp.us` sending subdomain, declared
 * production-only. Registering a reputation-isolated subdomain per ephemeral preview stage is
 * wasteful and wrong, so the stack yields this only for a production deploy; dev/preview use the
 * `EmailSenderLog` sink. Provisioning auto-creates the DKIM/SPF/return-path DNS records.
 *
 * The `send_email` worker binding is not declared here: the production adapter `bind()`s the
 * `EmailSenderBinding` descriptor at worker init, behind the same ENVIRONMENT gate
 * (`isProductionDeploy`, owned by `worker/environment.ts`, ADR 0088).
 */
import {adopt} from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/** The apex zone — adopted (already on Cloudflare DNS), never created/deleted by the stack. */
export const KAMPUS_ZONE_NAME = "kamp.us" as const;

export const SENDING_SUBDOMAIN = "send.kamp.us" as const;

export const provisionEmailSending = Effect.gen(function* () {
	// A zone carries no ownership markers, so alchemy refuses to take it over without
	// `adopt(true)`. Zones default to retain on removal — destroying the stack never deletes it.
	const zone = yield* Cloudflare.Zone.Zone("kampus_zone", {name: KAMPUS_ZONE_NAME}).pipe(
		adopt(true),
	);
	const sending = yield* Cloudflare.Email.SendingSubdomain("phoenix_email_sending", {
		zoneId: zone.zoneId,
		name: SENDING_SUBDOMAIN,
	});
	return {zoneId: zone.zoneId, sendingEnabled: sending.enabled};
});
