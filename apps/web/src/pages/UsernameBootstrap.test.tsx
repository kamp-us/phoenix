import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {FateClient} from "react-fate";
import {describe, expect, it, vi} from "vitest";
import {UsernameBootstrap} from "./UsernameBootstrap";

// `useFateClient` reads off `<FateClient>`'s plain context, so a stubbed
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
		// The prefill for elif@kamp.us is `elif`.
		expect(screen.getByRole("button").textContent).toBe("bu adı onayla");
		fireEvent.submit(screen.getByRole("button").closest("form")!);
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
		fireEvent.change(input, {target: {value: "elif-kaya"}});
		fireEvent.change(input, {target: {value: "elif"}});
		expect(screen.getByRole("button").textContent).toBe("bu adı onayla");
	});
});
