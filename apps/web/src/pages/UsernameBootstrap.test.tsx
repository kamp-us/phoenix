/**
 * The null-username bootstrap fallback (#1888 AC4). A permanent handle must never
 * commit off a reflexive "devam et" on the *unedited* email-derived prefill — that
 * reads to users as "the system chose my email as my username." So an untouched
 * prefill needs a deliberate confirm step; any edit commits directly.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {FateClient} from "react-fate";
import {describe, expect, it, vi} from "vitest";
import {UsernameBootstrap} from "./UsernameBootstrap";

// `useFateClient` reads the client off `<FateClient>`'s plain context; a stubbed
// `mutations.user.setUsername` is all the form touches.
function makeWrapper(setUsername: ReturnType<typeof vi.fn>) {
	const client = {mutations: {user: {setUsername}}};
	return function wrapper({children}: {children: ReactNode}) {
		return <FateClient client={client as never}>{children}</FateClient>;
	};
}

function renderBootstrap(setUsername: ReturnType<typeof vi.fn>, onComplete = vi.fn()) {
	const Wrapper = makeWrapper(setUsername);
	return render(
		<Wrapper>
			<UsernameBootstrap email="elif@kamp.us" onComplete={onComplete} />
		</Wrapper>,
	);
}

describe("UsernameBootstrap — the deliberate-confirm gate (#1888 AC4)", () => {
	it("does NOT commit the unedited email prefill on the first submit — it asks to confirm", () => {
		const setUsername = vi.fn(async () => ({}));
		renderBootstrap(setUsername);
		// The prefill for elif@kamp.us is `elif`; the button starts as a confirm ask.
		expect(screen.getByRole("button").textContent).toBe("bu adı onayla");
		fireEvent.submit(screen.getByRole("button").closest("form")!);
		// First submit only confirms — no mutation yet.
		expect(setUsername).not.toHaveBeenCalled();
	});

	it("commits the email prefill only after a deliberate confirm (second submit)", async () => {
		const setUsername = vi.fn(async () => ({}));
		const onComplete = vi.fn();
		renderBootstrap(setUsername, onComplete);
		const form = screen.getByRole("button").closest("form")!;
		fireEvent.submit(form); // confirm
		fireEvent.submit(form); // commit
		await waitFor(() => expect(setUsername).toHaveBeenCalledTimes(1));
		expect(setUsername).toHaveBeenCalledWith(expect.objectContaining({input: {value: "elif"}}));
		await waitFor(() => expect(onComplete).toHaveBeenCalled());
	});

	it("commits an EDITED handle directly, with no confirm step", async () => {
		const setUsername = vi.fn(async () => ({}));
		renderBootstrap(setUsername);
		const input = screen.getByLabelText("kullanıcı adı");
		fireEvent.change(input, {target: {value: "elif-kaya"}});
		// An edited value is not the email prefill → the button commits, not confirms.
		expect(screen.getByRole("button").textContent).toBe("devam et");
		fireEvent.submit(input.closest("form")!);
		await waitFor(() => expect(setUsername).toHaveBeenCalledTimes(1));
		expect(setUsername).toHaveBeenCalledWith(
			expect.objectContaining({input: {value: "elif-kaya"}}),
		);
	});

	it("re-arms the confirm gate if the user edits back to the prefill after confirming", () => {
		const setUsername = vi.fn(async () => ({}));
		renderBootstrap(setUsername);
		const input = screen.getByLabelText("kullanıcı adı");
		fireEvent.submit(input.closest("form")!); // confirm the prefill
		expect(screen.getByRole("button").textContent).toBe("devam et");
		// Editing away and back to the prefill resets confirmation — no silent commit.
		fireEvent.change(input, {target: {value: "elif-kaya"}});
		fireEvent.change(input, {target: {value: "elif"}});
		expect(screen.getByRole("button").textContent).toBe("bu adı onayla");
	});
});
