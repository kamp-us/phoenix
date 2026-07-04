/**
 * The signup→setUsername path (#1888). The reported bug: a chosen handle is
 * silently dropped when the post-signup `setUsername` fails, because the session is
 * already established and the redirect buries the failure. These pin the fix — a
 * failure parks on a visible, retryable surface and holds the redirect gate; a
 * success releases it; the chosen handle is never swallowed.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {FateClient} from "react-fate";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {AuthPage} from "./AuthPage";
import {endUsernameResolution, useUsernameResolutionPending} from "./signupUsernameGate";

const {signUpEmail, signInEmail} = vi.hoisted(() => ({
	signUpEmail: vi.fn(),
	signInEmail: vi.fn(),
}));
vi.mock("../auth/client", () => ({
	authClient: {
		signUp: {email: signUpEmail},
		signIn: {email: signInEmail},
	},
}));

function makeWrapper(setUsername: ReturnType<typeof vi.fn>) {
	const client = {mutations: {user: {setUsername}}};
	return function wrapper({children}: {children: ReactNode}) {
		return <FateClient client={client as never}>{children}</FateClient>;
	};
}

// A probe that surfaces the module-level redirect gate into the DOM so a test can
// assert whether the Layout redirect would be held.
function GateProbe() {
	return <span data-testid="gate">{useUsernameResolutionPending() ? "held" : "clear"}</span>;
}

function renderAuth(setUsername: ReturnType<typeof vi.fn>) {
	const Wrapper = makeWrapper(setUsername);
	return render(
		<Wrapper>
			<AuthPage />
			<GateProbe />
		</Wrapper>,
	);
}

function switchToSignUp() {
	fireEvent.click(screen.getByRole("button", {name: "kayıt ol"}));
}

function fillSignup(username: string) {
	fireEvent.change(screen.getByLabelText("görünen ad"), {target: {value: "Elif Kaya"}});
	fireEvent.change(screen.getByLabelText("e-posta"), {target: {value: "elif@kamp.us"}});
	fireEvent.change(screen.getByLabelText("parola"), {target: {value: "hunter2hunter2"}});
	if (username) {
		fireEvent.change(screen.getByLabelText(/kullanıcı adı/), {target: {value: username}});
	}
}

describe("AuthPage — signup→setUsername (#1888)", () => {
	beforeEach(() => {
		signUpEmail.mockReset();
		signInEmail.mockReset();
		signUpEmail.mockResolvedValue({error: null});
	});
	afterEach(() => {
		endUsernameResolution();
	});

	it("parks on a retryable surface and HOLDS the redirect when setUsername fails — the handle is not dropped", async () => {
		const setUsername = vi.fn(async () => ({error: {code: "TAKEN"}}));
		renderAuth(setUsername);
		switchToSignUp();
		fillSignup("elif-kaya");
		fireEvent.submit(screen.getByRole("button", {name: "hesap aç"}).closest("form")!);

		await waitFor(() => expect(setUsername).toHaveBeenCalledTimes(1));
		// The failure is visible, not swallowed: the blocking retry surface renders,
		// naming the chosen handle. (getByText throws if absent — presence is the assert.)
		await waitFor(() => screen.getByText("kullanıcı adı ayarlanamadı"));
		expect(screen.getByText("elif-kaya")).toBeTruthy();
		// And the redirect gate is HELD, so the Layout can't carry the user off /auth
		// into the email-prefill bootstrap while the chosen handle is unresolved.
		expect(screen.getByTestId("gate").textContent).toBe("held");
	});

	it("retry on the stuck surface re-attempts and, on success, RELEASES the redirect", async () => {
		const setUsername = vi
			.fn()
			.mockResolvedValueOnce({error: {code: "TAKEN"}})
			.mockResolvedValueOnce({error: null});
		renderAuth(setUsername);
		switchToSignUp();
		fillSignup("elif-kaya");
		fireEvent.submit(screen.getByRole("button", {name: "hesap aç"}).closest("form")!);
		await waitFor(() => screen.getByText("kullanıcı adı ayarlanamadı"));

		fireEvent.click(screen.getByRole("button", {name: "tekrar dene"}));
		await waitFor(() => expect(setUsername).toHaveBeenCalledTimes(2));
		// Handle landed → gate released → the Layout redirect proceeds.
		await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("clear"));
	});

	it("a clean signup+setUsername leaves the gate clear so the redirect fires normally", async () => {
		const setUsername = vi.fn(async () => ({error: null}));
		renderAuth(setUsername);
		switchToSignUp();
		fillSignup("elif-kaya");
		fireEvent.submit(screen.getByRole("button", {name: "hesap aç"}).closest("form")!);
		await waitFor(() => expect(setUsername).toHaveBeenCalledTimes(1));
		expect(setUsername).toHaveBeenCalledWith(
			expect.objectContaining({input: {value: "elif-kaya"}}),
		);
		expect(screen.getByTestId("gate").textContent).toBe("clear");
		expect(screen.queryByText("kullanıcı adı ayarlanamadı")).toBeNull();
	});

	it("abandoning the chosen handle releases the gate (deliberate fall-through to bootstrap)", async () => {
		const setUsername = vi.fn(async () => ({error: {code: "TAKEN"}}));
		renderAuth(setUsername);
		switchToSignUp();
		fillSignup("elif-kaya");
		fireEvent.submit(screen.getByRole("button", {name: "hesap aç"}).closest("form")!);
		await waitFor(() => screen.getByText("kullanıcı adı ayarlanamadı"));
		expect(screen.getByTestId("gate").textContent).toBe("held");

		fireEvent.click(screen.getByRole("button", {name: "bu adı bırak, sonra seçerim"}));
		await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("clear"));
	});

	it("a blank username field never touches setUsername and never holds the gate", async () => {
		const setUsername = vi.fn(async () => ({error: null}));
		renderAuth(setUsername);
		switchToSignUp();
		fillSignup("");
		fireEvent.submit(screen.getByRole("button", {name: "hesap aç"}).closest("form")!);
		await waitFor(() => expect(signUpEmail).toHaveBeenCalledTimes(1));
		expect(setUsername).not.toHaveBeenCalled();
		expect(screen.getByTestId("gate").textContent).toBe("clear");
	});
});
