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

/**
 * {@link makeNotificationStub}'s fail-on-contact double, recording each method reached. Every
 * bildirim emitter swallows its whole cause, so a dying method cannot show an emitter stayed
 * silent; a silent arm asserts `touched` is empty instead.
 */
export const makeTouchRecordingNotificationStub = (): {
	readonly layer: Layer.Layer<Notification>;
	readonly touched: ReadonlyArray<keyof NotificationShape>;
} => {
	const touched: Array<keyof NotificationShape> = [];
	const touching =
		(method: keyof NotificationShape) =>
		(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
			Effect.suspend(() => {
				touched.push(method);
				return die(method)();
			});
	const recording: NotificationShape = {
		record: touching("record"),
		recordAggregate: touching("recordAggregate"),
		recordDigest: touching("recordDigest"),
		listForRecipient: touching("listForRecipient"),
		unreadCount: touching("unreadCount"),
		markRead: touching("markRead"),
		markAllRead: touching("markAllRead"),
		resolveTargets: touching("resolveTargets"),
	};
	return {layer: Layer.succeed(Notification, recording), touched};
};
