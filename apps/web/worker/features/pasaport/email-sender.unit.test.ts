/** Drives both `EmailSender` adapters (ADR 0101) over substituted seams — no binding, no network. */
import {assert, describe, it} from "@effect/vitest";
import {RuntimeContext} from "alchemy";
import {Email} from "alchemy/Cloudflare";
import {Effect, Layer} from "effect";
import {EmailDeliveryLog} from "./email-delivery-log.ts";
import {
	EMAIL_FROM,
	EmailSender,
	EmailSenderCloudflareLive,
	EmailSenderLog,
	emailSenderLayerFor,
} from "./email-sender.ts";

const runtimeContext = Layer.succeed(RuntimeContext)({
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
});

type RecordedFailure = {address: string; reason: string};

/** Captures `recordSendFailure` calls so the adapter is assertable without a `Drizzle`/D1. */
const fakeDeliveryLog = (sink: RecordedFailure[]): Layer.Layer<EmailDeliveryLog> =>
	Layer.succeed(EmailDeliveryLog)(
		EmailDeliveryLog.of({
			recordSendFailure: (input) => Effect.sync(() => void sink.push(input)),
		}),
	);

type SentMessage = Parameters<Email.SendClient["send"]>[0];

/** `raw`/`sendRaw` die so an accidental call is loud. */
const fakeBinding = (
	onSend: (message: SentMessage) => Effect.Effect<{messageId: string}, Email.SendEmailError>,
): Layer.Layer<Email.Send> =>
	Layer.succeed(Email.Send)(
		Email.Send.of(() =>
			Effect.succeed<Email.SendClient>({
				raw: Effect.die("Email.Send.raw not exercised"),
				send: (message) => onSend(message),
				sendRaw: () => Effect.die("Email.Send.sendRaw not exercised"),
			}),
		),
	);

describe("EmailSenderCloudflareLive", () => {
	it.effect("calls the binding .send with the structured from/to/subject/html shape", () =>
		Effect.gen(function* () {
			const sent: SentMessage[] = [];
			const program = Effect.gen(function* () {
				const sender = yield* EmailSender;
				yield* sender.send({to: "user@example.com", subject: "Merhaba", html: "<p>selam</p>"});
			});

			yield* program.pipe(
				Effect.provide(
					EmailSenderCloudflareLive.pipe(
						Layer.provide(
							fakeBinding((message) => {
								sent.push(message);
								return Effect.succeed({messageId: "test-id"});
							}),
						),
						Layer.provide(runtimeContext),
						Layer.provide(fakeDeliveryLog([])),
					),
				),
			);

			assert.lengthOf(sent, 1);
			assert.deepStrictEqual(sent[0], {
				from: EMAIL_FROM,
				to: "user@example.com",
				subject: "Merhaba",
				html: "<p>selam</p>",
			});
		}),
	);

	it.effect("sends a text body when the message carries text", () =>
		Effect.gen(function* () {
			const sent: SentMessage[] = [];
			const program = Effect.flatMap(EmailSender, (sender) =>
				sender.send({to: "t@example.com", subject: "Konu", text: "düz metin"}),
			);

			yield* program.pipe(
				Effect.provide(
					EmailSenderCloudflareLive.pipe(
						Layer.provide(
							fakeBinding((message) => {
								sent.push(message);
								return Effect.succeed({messageId: "test-id"});
							}),
						),
						Layer.provide(runtimeContext),
						Layer.provide(fakeDeliveryLog([])),
					),
				),
			);

			assert.deepStrictEqual(sent[0], {
				from: EMAIL_FROM,
				to: "t@example.com",
				subject: "Konu",
				text: "düz metin",
			});
		}),
	);

	it.effect("records a SendEmailError to the delivery log AND stays fail-soft", () =>
		Effect.gen(function* () {
			const recorded: RecordedFailure[] = [];
			const program = Effect.flatMap(EmailSender, (sender) =>
				sender.send({to: "user@example.com", subject: "x", text: "y"}),
			);

			// The public `send` is E = never, so a rejected delivery must still complete with
			// void — it can never fail the auth flow.
			const result = yield* program.pipe(
				Effect.provide(
					EmailSenderCloudflareLive.pipe(
						Layer.provide(
							fakeBinding(() => Effect.fail(new Email.SendEmailError({message: "binding boom"}))),
						),
						Layer.provide(runtimeContext),
						Layer.provide(fakeDeliveryLog(recorded)),
					),
				),
				Effect.exit,
			);

			assert.isTrue(result._tag === "Success");
			assert.deepStrictEqual(recorded, [{address: "user@example.com", reason: "binding boom"}]);
		}),
	);
});

describe("EmailSenderLog", () => {
	it.effect("resolves the sink and accepts a send without a binding", () =>
		Effect.gen(function* () {
			const sender = yield* EmailSender;
			yield* sender.send({to: "dev@example.com", subject: "log", text: "no real send"});
		}).pipe(Effect.provide(EmailSenderLog)),
	);
});

describe("emailSenderLayerFor", () => {
	it("picks the log sink for development and preview, the CF adapter for production", () => {
		assert.strictEqual(emailSenderLayerFor("development"), EmailSenderLog);
		assert.strictEqual(emailSenderLayerFor("preview"), EmailSenderLog);
		assert.strictEqual(emailSenderLayerFor("production"), EmailSenderCloudflareLive);
	});
});
