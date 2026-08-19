/**
 * The append-only write port over `email_delivery_event`, kept separate from `EmailSender`
 * so the send adapter depends on a fakeable port rather than `Drizzle`.
 *
 * Fail-soft by contract (`E = never`): the send path must never throw into better-auth's
 * email callbacks, so a D1 failure on this audit append is logged and swallowed.
 */
import {eq} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";

export class EmailDeliveryLog extends Context.Service<
	EmailDeliveryLog,
	{
		/**
		 * Append a `fail` event for a synchronous send-time rejection, resolving `userId`
		 * from the address when a `user` row exists.
		 */
		readonly recordSendFailure: (input: {
			readonly address: string;
			readonly reason: string;
		}) => Effect.Effect<void>;
	}
>()("@kampus/pasaport/EmailDeliveryLog") {}

/** The `Effect.ignore` is what keeps the public method at `E = never`. */
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
