/**
 * `EmailSender` — the provider-agnostic transactional-email port (ADR 0101).
 * Adapters are picked by the `ENVIRONMENT` gate (ADR 0088); a preview MUST NOT
 * deliver real mail.
 *
 * `send` is fail-soft by contract — `E = never`. A thrown better-auth email callback
 * would fail the sign-in flow, so the adapter swallows delivery failures internally
 * and "an email can't fail the auth flow" becomes a type rather than a convention
 * (.patterns/effect-context-service.md, "Wrapping a non-Effect client").
 */
import {RuntimeContext} from "alchemy";
import {Email} from "alchemy/Cloudflare";
import {Context, Effect, Layer} from "effect";
import {environment} from "../../config.ts";
import {type Environment, isProduction} from "../../environment.ts";
import {EmailDeliveryLog} from "./email-delivery-log.ts";

// The body is a union, so a message with no renderable body is unrepresentable.
export type EmailBody = {readonly html: string} | {readonly text: string};

export type EmailMessage = {
	readonly to: string;
	readonly subject: string;
} & EmailBody;

export class EmailSender extends Context.Service<
	EmailSender,
	{
		readonly send: (message: EmailMessage) => Effect.Effect<void>;
	}
>()("@kampus/pasaport/EmailSender") {}

export const EMAIL_FROM = "pasaport@send.kamp.us" as const;

export const EmailSenderLog: Layer.Layer<EmailSender> = Layer.succeed(EmailSender)(
	EmailSender.of({
		send: (message) =>
			Effect.log("[pasaport] email (log sink — not sent)", {
				to: message.to,
				subject: message.subject,
			}),
	}),
);

// Destination is deliberately unrestricted — omitting `destinationAddress` lets the
// worker reach every signed-up user's verified address.
export const EmailSenderBinding = Email.SendEmail("EmailSender", {
	allowedSenderAddresses: [EMAIL_FROM],
});

/**
 * Production adapter. What it records has an honest limit (#2687/#2691): a
 * `SendEmailError` is a send REJECTION caught at send time, NOT an asynchronous hard
 * bounce or spam complaint — those arrive after the SMTP handshake and need the
 * CF delivery-event surface (#2694).
 *
 * `RuntimeContext` and `EmailDeliveryLog` are resolved once at layer build and baked
 * into the closure, so the public `send` is runnable standalone from better-auth's
 * async callbacks without re-threading context.
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

// Pure over an injected env, so the selection is unit-testable without a real
// ConfigProvider.
export const emailSenderLayerFor = (
	env: Environment,
): Layer.Layer<EmailSender, never, RuntimeContext | Email.Send | EmailDeliveryLog> =>
	isProduction(env) ? EmailSenderCloudflareLive : EmailSenderLog;

// `ENVIRONMENT` defaults fail-closed to `production` (ADR 0088).
export const EmailSenderLive: Layer.Layer<
	EmailSender,
	never,
	RuntimeContext | Email.Send | EmailDeliveryLog
> = Layer.unwrap(
	Effect.gen(function* () {
		// A value outside the three literals is a malformed env, unrecoverable.
		const env = yield* environment.pipe(Effect.orDie);
		return emailSenderLayerFor(env);
	}),
);
