import {describe, expect, it} from "vitest";
import {
	validateEmail,
	validateName,
	validatePassword,
	validateSignIn,
	validateSignUp,
} from "./authValidation";

describe("authValidation — catalog keys, not messages", () => {
	it("görünen ad is required", () => {
		expect(validateName("")).toBe("auth.validation.nameRequired");
		expect(validateName("   ")).toBe("auth.validation.nameRequired");
		expect(validateName("Elif Kaya")).toBeNull();
	});

	it("e-posta is required and format-checked", () => {
		expect(validateEmail("")).toBe("auth.validation.emailRequired");
		expect(validateEmail("elif")).toBe("auth.validation.emailInvalid");
		expect(validateEmail("elif@kamp")).toBe("auth.validation.emailInvalid");
		expect(validateEmail("elif kaya@kamp.us")).toBe("auth.validation.emailInvalid");
		expect(validateEmail("elif@kamp.us")).toBeNull();
		expect(validateEmail("  elif@kamp.us  ")).toBeNull();
	});

	it("parola is required; the length floor is sign-up only", () => {
		expect(validatePassword("", "sign-up")).toBe("auth.validation.passwordRequired");
		expect(validatePassword("short", "sign-up")).toBe("auth.validation.passwordTooShort");
		expect(validatePassword("hunter2hunter2", "sign-up")).toBeNull();
		expect(validatePassword("", "sign-in")).toBe("auth.validation.passwordRequired");
		expect(validatePassword("short", "sign-in")).toBeNull();
	});

	it("validateSignUp returns the first failure in visual field order", () => {
		expect(validateSignUp("", "elif@kamp.us", "hunter2hunter2")).toBe(
			"auth.validation.nameRequired",
		);
		expect(validateSignUp("Elif", "bad", "hunter2hunter2")).toBe("auth.validation.emailInvalid");
		expect(validateSignUp("Elif", "elif@kamp.us", "short")).toBe(
			"auth.validation.passwordTooShort",
		);
		expect(validateSignUp("Elif", "elif@kamp.us", "hunter2hunter2")).toBeNull();
	});

	it("validateSignIn checks e-posta then a non-empty parola", () => {
		expect(validateSignIn("", "hunter2")).toBe("auth.validation.emailRequired");
		expect(validateSignIn("elif@kamp.us", "")).toBe("auth.validation.passwordRequired");
		expect(validateSignIn("elif@kamp.us", "x")).toBeNull();
	});
});
