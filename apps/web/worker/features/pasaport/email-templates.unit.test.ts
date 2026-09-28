/**
 * Unit coverage for the transactional email copy (ADR 0101): each template's
 * `to`/`subject`/body, and that the change-email confirmation addresses the CURRENT email,
 * not the new one — the security-load-bearing detail of the flow.
 */
import {assert, describe, it} from "@effect/vitest";
import type {EmailMessage} from "./email-sender.ts";
import {
	changeEmailConfirmationEmail,
	magicLinkEmail,
	verificationEmail,
} from "./email-templates.ts";

const hasText = (m: EmailMessage): m is EmailMessage & {text: string} => "text" in m;

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
