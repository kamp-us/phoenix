/**
 * Unit coverage for the transactional email copy + the callback dispatch
 * contract (ADR 0101). The three better-auth callbacks (magic-link, verify,
 * change-email confirmation) each build their `EmailMessage` from these template
 * functions and dispatch it through the `EmailSender` port. This test asserts:
 *
 *   - each template carries the required `to`/`subject` and a body, the recipient
 *     and link the callback was handed, and Turkish subject copy;
 *   - a built message dispatched through a recording `EmailSender` reaches `send`
 *     verbatim — the callback→port wiring;
 *   - the change-email confirmation addresses the CURRENT email (not the new one),
 *     the security-load-bearing detail of the flow #75 needs.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {type EmailMessage, EmailSender} from "./email-sender.ts";
import {
	changeEmailConfirmationEmail,
	magicLinkEmail,
	verificationEmail,
} from "./email-templates.ts";

const hasText = (m: EmailMessage): m is EmailMessage & {text: string} => "text" in m;

const recordingSender = (sink: EmailMessage[]): Layer.Layer<EmailSender> =>
	Layer.succeed(EmailSender)(
		EmailSender.of({
			send: (message) => Effect.sync(() => void sink.push(message)),
		}),
	);

describe("email templates", () => {
	it("magicLinkEmail carries the recipient, the link, and Turkish subject", () => {
		const msg = magicLinkEmail("user@example.com", "https://kamp.us/magic?token=abc");
		assert.strictEqual(msg.to, "user@example.com");
		assert.match(msg.subject, /giriş/i);
		assert.isTrue(hasText(msg) && msg.text.includes("https://kamp.us/magic?token=abc"));
	});

	it("verificationEmail carries the recipient, the link, and Turkish subject", () => {
		const msg = verificationEmail("new@example.com", "https://kamp.us/verify?token=xyz");
		assert.strictEqual(msg.to, "new@example.com");
		assert.match(msg.subject, /doğrula/i);
		assert.isTrue(hasText(msg) && msg.text.includes("https://kamp.us/verify?token=xyz"));
	});

	it("changeEmailConfirmationEmail goes to the CURRENT address and names the new one", () => {
		const msg = changeEmailConfirmationEmail(
			"current@example.com",
			"new@example.com",
			"https://kamp.us/change?token=qrs",
		);
		// Sent to the address that already owns the account — the security gate.
		assert.strictEqual(msg.to, "current@example.com");
		assert.isTrue(hasText(msg) && msg.text.includes("new@example.com"));
		assert.isTrue(hasText(msg) && msg.text.includes("https://kamp.us/change?token=qrs"));
	});
});

describe("callback dispatch through EmailSender", () => {
	it.effect("a built template reaches the port's send verbatim", () =>
		Effect.gen(function* () {
			const sink: EmailMessage[] = [];
			const built = magicLinkEmail("u@example.com", "https://kamp.us/m");
			const dispatch = Effect.flatMap(EmailSender, (sender) => sender.send(built));
			yield* dispatch.pipe(Effect.provide(recordingSender(sink)));
			assert.deepStrictEqual(sink[0], built);
		}),
	);
});
