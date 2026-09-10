/** @vitest-environment jsdom */
import {act, cleanup, render, screen, waitFor} from "@testing-library/react";
import {Deferred, Effect, Stream, SubscriptionRef} from "effect";
import {Socket} from "effect/unstable/socket";
import {afterEach, expect, it} from "vitest";
import {descriptions} from "../commands/parse/fixtures.ts";
import type {PageAttachment} from "../shell/transport/browser.ts";
import {useSpellRegistry} from "./spell-registry.ts";

afterEach(cleanup);
const Probe = ({page}: {page: Pick<PageAttachment, "spells" | "closed">}) => {
	const registry = useSpellRegistry(page);
	return (
		<p>
			{registry === undefined ? "Waiting" : registry.map((row) => row.path.join(".")).join(",")}
		</p>
	);
};

it("clears old descriptions on attachment replacement and ignores the previous stream", async () => {
	const old = Effect.runSync(SubscriptionRef.make(descriptions));
	const first = {spells: SubscriptionRef.changes(old), closed: Effect.never};
	const next = {spells: Stream.never, closed: Effect.never};
	const view = render(<Probe page={first} />);
	await waitFor(() => expect(screen.getByText(/window.close/)).toBeDefined());
	view.rerender(<Probe page={next} />);
	expect(screen.getByText("Waiting")).toBeDefined();
	await act(() => Effect.runPromise(SubscriptionRef.set(old, descriptions)));
	expect(screen.getByText("Waiting")).toBeDefined();
});

it("drops its catalogue and stops observing when the connection closes", async () => {
	const registry = Effect.runSync(SubscriptionRef.make(descriptions));
	const ended = Effect.runSync(Deferred.make<Socket.SocketError>());
	const page = {spells: SubscriptionRef.changes(registry), closed: Deferred.await(ended)};
	render(<Probe page={page} />);
	await waitFor(() => expect(screen.getByText(/window.close/)).toBeDefined());
	await act(() =>
		Effect.runPromise(
			Deferred.succeed(
				ended,
				new Socket.SocketError({reason: new Socket.SocketCloseError({code: 1006})}),
			),
		),
	);
	expect(screen.getByText("Waiting")).toBeDefined();
	await act(() => Effect.runPromise(SubscriptionRef.set(registry, descriptions)));
	expect(screen.getByText("Waiting")).toBeDefined();
});
