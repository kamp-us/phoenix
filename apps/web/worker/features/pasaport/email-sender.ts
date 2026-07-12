/**
 * `EmailSender` — the provider-agnostic transactional-email port (ADR 0101).
 *
 * One method, `send`, that every better-auth email callback (magic-link,
 * verification, change-email confirmation) routes through. The provider is
 * Cloudflare Email Service (the native `send_email` binding via alchemy's
 * `Cloudflare.SendEmail`), but the port is the seam that keeps a future swap to
 * one adapter — `EmailSenderCloudflare` is the only place that names the
 * binding.
 *
 * Two adapters, selected by the `ENVIRONMENT` gate (ADR 0088), exactly like
 * `authUrlConfig` in `better-auth-live.ts`:
 *   - development + preview → `EmailSenderLog`: logs `{to, subject}` via
 *     `Effect.log`, never sends. A preview MUST NOT deliver real mail.
 *   - production → `EmailSenderCloudflare`: calls the binding's runtime
 *     `.send({from, to, subject, html?, text?})` (the structured Email Service
 *     shape, verified against the CF Workers Email API docs — no raw MIME).
 *
 * `send` is fail-soft by contract: its error channel is `never`. better-auth's
 * email callbacks must not throw (a thrown callback fails the sign-in/verify
 * flow), so a delivery failure is logged and swallowed inside the adapter — the
 * empty error channel makes "an email can't fail the auth flow" a type, not a
 * per-call-site convention (the swallow-inside-the-layer law of
 * `.patterns/effect-context-service.md` §"Wrapping a non-Effect client").
 */
import {RuntimeContext} from "alchemy";
import {Email} from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {environment} from "../../config.ts";
import {type Environment, isProduction} from "../../environment.ts";
import {EmailDeliveryLog} from "./email-delivery-log.ts";

/**
 * A transactional message. Invalid states are unrepresentable: `to` + `subject`
 * are required, and the body is a `html | text` union — every message carries at
 * least one renderable body, never an empty send.
 */
export type EmailBody = {readonly html: string} | {readonly text: string};

export type EmailMessage = {
	readonly to: string;
	readonly subject: string;
} & EmailBody;

export class EmailSender extends Context.Service<
	EmailSender,
	{
		/** Deliver one transactional email. Fail-soft — `E = never`. */
		readonly send: (message: EmailMessage) => Effect.Effect<void>;
	}
>()("@kampus/pasaport/EmailSender") {}

/** The from-address every transactional email is sent on the `send.kamp.us` sending subdomain. */
export const EMAIL_FROM = "pasaport@send.kamp.us" as const;

/**
 * Dev/preview adapter — logs the recipient + subject, never sends. This is the
 * old `isLocalDev` `console.log` branch, lifted behind the port (and widened to
 * `preview`, which must never deliver real mail).
 */
export const EmailSenderLog: Layer.Layer<EmailSender> = Layer.succeed(EmailSender)(
	EmailSender.of({
		send: (message) =>
			Effect.log("[pasaport] email (log sink — not sent)", {
				to: message.to,
				subject: message.subject,
			}),
	}),
);

/**
 * The `send_email` binding descriptor. `allowedSenderAddresses` pins the worker
 * to the one `send.kamp.us` from-address; destination is unrestricted (omit
 * `destinationAddress`/`allowedDestinationAddresses` → send to any verified
 * recipient — every signed-up user's address).
 */
export const EmailSenderBinding = Email.SendEmail("EmailSender", {
	allowedSenderAddresses: [EMAIL_FROM],
});

/**
 * Production adapter — delivers via the Cloudflare Email Service `send_email`
 * binding (alchemy `Cloudflare.SendEmail`, runtime `.send(...)`). The binding's
 * `send` already wraps any failure in a typed `SendEmailError`; on that rejection
 * the adapter appends a `fail` event to the delivery log (`EmailDeliveryLog`) and
 * swallows the error so the callback never throws and the public method's `E = never`.
 *
 * The captured signal's honest limit (epic #2687, Child #2691): a synchronous
 * `SendEmailError` is a send REJECTION caught at send time — NOT an asynchronous hard
 * bounce or spam complaint, which arrive after the SMTP handshake and need the CF
 * delivery-event surface (Child #2694, CF-gated). That buildable-today vs CF-gated
 * fault line is what the epic splits on; this adapter only records the synchronous half.
 *
 * The binding's `.send` carries `R = RuntimeContext`; it and `EmailDeliveryLog` are
 * resolved once at layer build (ambient/stable for the isolate) and baked into the
 * closure, so the public `send` is `Effect<void, never, never>` — runnable standalone
 * from better-auth's async callbacks without re-threading context.
 */
export const EmailSenderCloudflareLive = Layer.effect(
	EmailSender,
	Effect.gen(function* () {
		const descriptor = yield* EmailSenderBinding;
		const email = yield* Email.Send(descriptor);
		const runtimeContext = yield* RuntimeContext;
		const deliveryLog = yield* EmailDeliveryLog;
		return EmailSender.of({
			send: (message) =>
				email
					.send({
						from: EMAIL_FROM,
						to: message.to,
						subject: message.subject,
						...("html" in message ? {html: message.html} : {text: message.text}),
					})
					.pipe(
						Effect.provideService(RuntimeContext, runtimeContext),
						Effect.asVoid,
						Effect.catch((error) =>
							deliveryLog.recordSendFailure({address: message.to, reason: error.message}),
						),
					),
		});
	}),
);

/**
 * The layer factory — reads `ENVIRONMENT` once and picks the adapter, the same
 * shape as `authUrlConfig`. development/preview → log sink (no binding touched);
 * production → the CF Email Service adapter. Pure over an injected env so the
 * selection is unit-testable without a real ConfigProvider.
 */
export const emailSenderLayerFor = (
	env: Environment,
): Layer.Layer<EmailSender, never, RuntimeContext | Email.Send | EmailDeliveryLog> =>
	isProduction(env) ? EmailSenderCloudflareLive : EmailSenderLog;

/**
 * The resolved-from-Config layer used at the worker entry. Reads `ENVIRONMENT`
 * (fail-closed default `production`, ADR 0088) and defers to `emailSenderLayerFor`.
 */
export const EmailSenderLive: Layer.Layer<
	EmailSender,
	never,
	RuntimeContext | Email.Send | EmailDeliveryLog
> = Layer.unwrap(
	Effect.gen(function* () {
		// `orDie`: a value outside the three literals is a malformed env, unrecoverable
		// (same stance as `better-auth-live.ts`).
		const env = yield* environment.pipe(Effect.orDie);
		return emailSenderLayerFor(env);
	}),
);
