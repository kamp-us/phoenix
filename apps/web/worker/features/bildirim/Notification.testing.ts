/**
 * The shared {@link Notification} test double. Every method fails on contact by default; a test
 * overrides only the method under test. A factory, not a shared instance
 * (`.patterns/effect-testing.md`).
 */
import {Effect, Layer} from "effect";
import {Notification} from "./Notification.ts";

type NotificationShape = typeof Notification.Service;

const die =
	(method: string) =>
	(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
		Effect.die(new Error(`Notification.${method} touched an unexpected method`));

const failOnContact: NotificationShape = {
	record: die("record"),
	recordAggregate: die("recordAggregate"),
	recordDigest: die("recordDigest"),
	listForRecipient: die("listForRecipient"),
	unreadCount: die("unreadCount"),
	markRead: die("markRead"),
	markAllRead: die("markAllRead"),
	resolveTargets: die("resolveTargets"),
};

export const makeNotificationStub = (
	overrides: Partial<NotificationShape> = {},
): Layer.Layer<Notification> => Layer.succeed(Notification, {...failOnContact, ...overrides});
