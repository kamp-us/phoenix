import {Effect, Fiber, Stream} from "effect";
import {useEffect, useState} from "react";
import type {RegistryDescription} from "../protocol/registry-description.ts";
import type {PageAttachment} from "../shell/transport/browser.ts";

type Source = Pick<PageAttachment, "spells" | "closed">;

export const useSpellRegistry = (page: Source): RegistryDescription | undefined => {
	const [held, setHeld] = useState<{
		readonly page: Source;
		readonly registry: RegistryDescription;
	} | null>(null);
	useEffect(() => {
		let current = true;
		const pump = Effect.runFork(
			Stream.runForEach(page.spells, (registry) =>
				Effect.sync(() => {
					if (current) setHeld({page, registry});
				}),
			),
		);
		const closed = Effect.runFork(
			Effect.flatMap(page.closed, () =>
				Effect.sync(() => {
					if (!current) return;
					current = false;
					setHeld(null);
					Effect.runFork(Fiber.interrupt(pump));
				}),
			),
		);
		return () => {
			current = false;
			Effect.runFork(Fiber.interrupt(pump));
			Effect.runFork(Fiber.interrupt(closed));
		};
	}, [page]);
	return held?.page === page ? held.registry : undefined;
};
