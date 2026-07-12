/**
 * `EmailDeliveryLog` — the append-only write port over `email_delivery_event` (epic
 * #2687). It is the seam the send adapter (`email-sender.ts`) records a send-time
 * rejection through, kept separate from `EmailSender` so the adapter depends on a
 * fakeable port, not on `Drizzle` directly.
 *
 * `recordSendFailure` is fail-soft by contract — its error channel is `never`. The send
 * path it feeds must never throw into better-auth's email callbacks (an email can't fail
 * the auth flow, `email-sender.ts`), so the audit append is best-effort: a D1 failure is
 * logged and swallowed inside the layer rather than surfaced. See `email-delivery.ts` for
 * the projection this log feeds and the honest limit of the send-time signal.
 */
import {eq} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

export class EmailDeliveryLog extends Context.Service<
	EmailDeliveryLog,
	{
		/**
		 * Append a `fail` event for a synchronous send-time rejection. Resolves the
		 * recipient's `userId` from the address when a `user` row exists (else records the
		 * event by address alone). Fail-soft — `E = never`.
		 */
		readonly recordSendFailure: (input: {
			readonly address: string;
			readonly reason: string;
		}) => Effect.Effect<void>;
	}
>()("@kampus/pasaport/EmailDeliveryLog") {}

/**
 * The Drizzle-backed adapter. The `userId` lookup and the insert both run against D1; a
 * `DrizzleError` from either is swallowed (`Effect.ignore`) so the public method stays
 * `E = never` — the append is audit, never load-bearing on the send.
 */
export const EmailDeliveryLogLive: Layer.Layer<EmailDeliveryLog, never, Drizzle> = Layer.effect(
	EmailDeliveryLog,
	Effect.gen(function* () {
		const {run} = yield* Drizzle;
		return EmailDeliveryLog.of({
			recordSendFailure: ({address, reason}) =>
				run((db) =>
					db
						.select({id: schema.user.id})
						.from(schema.user)
						.where(eq(schema.user.email, address))
						.limit(1)
						.then((rows) => rows[0]?.id ?? null),
				).pipe(
					Effect.flatMap((userId) =>
						run((db) =>
							db.insert(schema.emailDeliveryEvent).values({
								id: crypto.randomUUID(),
								userId,
								address,
								action: "fail",
								reason,
								createdAt: new Date(),
							}),
						),
					),
					Effect.asVoid,
					Effect.ignore({log: "Warn"}),
				),
		});
	}),
);
