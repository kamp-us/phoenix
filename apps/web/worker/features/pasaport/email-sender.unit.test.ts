/**
 * T0 unit coverage for the `EmailSender` port (ADR 0101). Drives both adapters
 * over substituted seams — no binding, no network:
 *
 *   - `EmailSenderCloudflareLive` over a FAKE `SendEmailBinding`: asserts it
 *     calls the binding's `.send` with the correct from/to/subject/body shape,
 *     and that a binding failure is swallowed (the public `send` is `E = never`,
 *     so a delivery failure never throws into better-auth);
 *   - `EmailSenderLog`: the dev/preview sink resolves without a binding;
 *   - `emailSenderLayerFor`: the ENVIRONMENT gate picks the log sink for
 *     development/preview and the CF adapter for production.
 */
import {assert, describe, it} from "@effect/vitest";
import {RuntimeContext} from "alchemy";
import {SendEmailBinding, type SendEmailClient, SendEmailError} from "alchemy/Cloudflare";
import {Effect, Layer} from "effect";
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

type SentMessage = Parameters<SendEmailClient["send"]>[0];

/**
 * A fake `SendEmailBinding`: `SendEmail.bind(descriptor)` resolves to a client
 * whose `send` is supplied by the test. `raw`/`sendRaw` die so an accidental
 * call is loud.
 */
const fakeBinding = (
	onSend: (message: SentMessage) => Effect.Effect<{messageId: string}, SendEmailError>,
): Layer.Layer<SendEmailBinding> =>
	Layer.succeed(SendEmailBinding)(
		SendEmailBinding.of(() =>
			Effect.succeed<SendEmailClient>({
				raw: Effect.die("SendEmailBinding.raw not exercised"),
				send: (message) => onSend(message),
				sendRaw: () => Effect.die("SendEmailBinding.sendRaw not exercised"),
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

	it.effect("fails soft: a binding send error never throws into the caller", () =>
		Effect.gen(function* () {
			const program = Effect.flatMap(EmailSender, (sender) =>
				sender.send({to: "user@example.com", subject: "x", text: "y"}),
			);

			// The send fails at the binding, but the public `send` is E = never — the
			// program completes with void rather than failing.
			const result = yield* program.pipe(
				Effect.provide(
					EmailSenderCloudflareLive.pipe(
						Layer.provide(
							fakeBinding(() => Effect.fail(new SendEmailError({message: "binding boom"}))),
						),
						Layer.provide(runtimeContext),
					),
				),
				Effect.exit,
			);

			assert.isTrue(result._tag === "Success");
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
