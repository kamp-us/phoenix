import {describe, expect, it} from "vitest";
import {
	validateEmail,
	validateName,
	validatePassword,
	validateSignIn,
	validateSignUp,
} from "./authValidation";

describe("authValidation — Turkish field messages", () => {
	it("görünen ad is required", () => {
		expect(validateName("")).toBe("görünen ad gerekli");
		expect(validateName("   ")).toBe("görünen ad gerekli");
		expect(validateName("Elif Kaya")).toBeNull();
	});

	it("e-posta is required and format-checked", () => {
		expect(validateEmail("")).toBe("e-posta gerekli");
		expect(validateEmail("elif")).toBe("geçerli bir e-posta gir");
		expect(validateEmail("elif@kamp")).toBe("geçerli bir e-posta gir");
		expect(validateEmail("elif kaya@kamp.us")).toBe("geçerli bir e-posta gir");
		expect(validateEmail("elif@kamp.us")).toBeNull();
		expect(validateEmail("  elif@kamp.us  ")).toBeNull();
	});

	it("parola is required; the length floor is sign-up only", () => {
		expect(validatePassword("", "sign-up")).toBe("parola gerekli");
		expect(validatePassword("short", "sign-up")).toBe("parola en az 8 karakter olmalı");
		expect(validatePassword("hunter2hunter2", "sign-up")).toBeNull();
		// Sign-in requires only a non-empty value — the length floor is the server's business.
		expect(validatePassword("", "sign-in")).toBe("parola gerekli");
		expect(validatePassword("short", "sign-in")).toBeNull();
	});

	it("validateSignUp returns the first failure in visual field order", () => {
		expect(validateSignUp("", "elif@kamp.us", "hunter2hunter2")).toBe("görünen ad gerekli");
		expect(validateSignUp("Elif", "bad", "hunter2hunter2")).toBe("geçerli bir e-posta gir");
		expect(validateSignUp("Elif", "elif@kamp.us", "short")).toBe("parola en az 8 karakter olmalı");
		expect(validateSignUp("Elif", "elif@kamp.us", "hunter2hunter2")).toBeNull();
	});

	it("validateSignIn checks e-posta then a non-empty parola", () => {
		expect(validateSignIn("", "hunter2")).toBe("e-posta gerekli");
		expect(validateSignIn("elif@kamp.us", "")).toBe("parola gerekli");
		expect(validateSignIn("elif@kamp.us", "x")).toBeNull();
	});
});
