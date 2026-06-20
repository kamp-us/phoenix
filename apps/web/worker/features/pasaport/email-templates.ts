/**
 * Transactional email copy (ADR 0101). Turkish user-facing copy (the
 * product-copy rule in CLAUDE.md); the identifiers + the `EmailMessage` shape
 * stay English. Each builder returns an `EmailMessage` the `EmailSender` port
 * delivers — pure functions of their inputs, so the copy is unit-inspectable
 * without touching the binding.
 */
import type {EmailMessage} from "./email-sender.ts";

/** The magic-link sign-in email — better-auth's `magicLink.sendMagicLink`. */
export const magicLinkEmail = (to: string, url: string): EmailMessage => ({
	to,
	subject: "kamp.us giriş bağlantın",
	text: `kamp.us'a giriş yapmak için bu bağlantıya tıkla:\n\n${url}\n\nBu bağlantıyı sen istemediysen bu e-postayı görmezden gelebilirsin.`,
});

/** The email-verification email — better-auth's `emailVerification.sendVerificationEmail`. */
export const verificationEmail = (to: string, url: string): EmailMessage => ({
	to,
	subject: "kamp.us e-posta adresini doğrula",
	text: `E-posta adresini doğrulamak için bu bağlantıya tıkla:\n\n${url}\n\nBu hesabı sen oluşturmadıysan bu e-postayı görmezden gelebilirsin.`,
});

/**
 * The change-email confirmation — better-auth's
 * `user.changeEmail.sendChangeEmailConfirmation`, sent to the CURRENT address so
 * the user approves the switch before it takes effect.
 */
export const changeEmailConfirmationEmail = (
	to: string,
	newEmail: string,
	url: string,
): EmailMessage => ({
	to,
	subject: "kamp.us e-posta değişikliğini onayla",
	text: `Hesabının e-posta adresini ${newEmail} olarak değiştirmek için bir istek aldık.\n\nOnaylamak için bu bağlantıya tıkla:\n\n${url}\n\nBu değişikliği sen istemediysen bu e-postayı görmezden gel; adresin değişmeyecek.`,
});
