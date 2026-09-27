/**
 * The half of "Open project…" that talks to the kernel (#9697): read what the shown step lists, and
 * carry out what a step's key answered. Everything it decides is `../picker/open-project.ts`'s; this
 * hook only holds what is in flight, which the window's view slot must not: a listing read from the
 * kernel, and an open that is waiting, perhaps on the trust prompt.
 *
 * What was read is kept per step while the picker stays on its steps, so Escape back to a folder
 * already listed shows it at once, and dropped the moment the picker leaves them: the next "Open
 * project…" reads the recent folders fresh, since an open in between moved them.
 */

import type {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/index";
import {Effect, Fiber} from "effect";
import {useCallback, useEffect, useRef, useState} from "react";
import type {ShellMsg} from "../core/index.ts";
import {
	browseStep,
	browsing,
	folderUnreadable,
	LOADING,
	landedOn,
	type Opening,
	type OpenProjectAnswer,
	type OpenProjectStep,
	type PickerView,
	type ProjectOpener,
	projectNotOpened,
	type StepData,
	stepKey,
	withRefusal,
} from "../picker/browser.ts";

export interface OpenProjectSurface {
	/** What has been read for the step shown, or `LOADING` until it has. */
	readonly data: StepData;
	/** The open in flight, if one is. */
	readonly opening: Opening | null;
	readonly run: (answer: OpenProjectAnswer) => void;
}

const read = (opener: ProjectOpener, step: OpenProjectStep): Effect.Effect<StepData> =>
	(step._tag === "Recent"
		? Effect.map(opener.recent, (projects): StepData => ({_tag: "Recent", projects}))
		: Effect.map(opener.browse(step.folder), (listing): StepData => ({_tag: "Folder", listing}))
	).pipe(
		Effect.catch((failure) =>
			Effect.succeed<StepData>({_tag: "Unreadable", reason: failure.reason}),
		),
	);

export const useOpenProject = ({
	windowId,
	view,
	opener,
	dispatch,
}: {
	readonly windowId: WindowId;
	readonly view: PickerView;
	readonly opener: ProjectOpener | null;
	readonly dispatch: (msg: ShellMsg) => void;
}): OpenProjectSurface => {
	const step = opener === null ? null : view.step;
	const key = step === null ? null : stepKey(step);
	const [readings, setReadings] = useState<ReadonlyMap<string, StepData>>(new Map());
	const [opening, setOpening] = useState<Opening | null>(null);
	// The answers below land after the view they were asked from, so each writes onto the newest.
	const latest = useRef(view);
	latest.current = view;
	const shown = useRef(step);
	shown.current = step;

	const setView = useCallback(
		(next: PickerView) => dispatch({type: "window.setView", windowId, view: next}),
		[dispatch, windowId],
	);

	const known = key !== null && readings.has(key);
	useEffect(() => {
		if (key === null) {
			setReadings((current) => (current.size === 0 ? current : new Map()));
			return;
		}
		const asked = shown.current;
		if (known || opener === null || asked === null) return;
		const fiber = Effect.runFork(
			Effect.flatMap(read(opener, asked), (data) =>
				Effect.sync(() => setReadings((current) => new Map(current).set(key, data))),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [key, known, opener]);

	const run = useCallback(
		(answer: OpenProjectAnswer) => {
			switch (answer._tag) {
				case "Moved":
				case "Cleared":
				case "Filtering":
					setView(answer.view);
					return;
				case "Focus":
					setView(landedOn(latest.current, answer.key, answer.name, "already-open"));
					return;
				case "Browse": {
					if (opener === null) return;
					// Read first, then move: a folder that cannot be read leaves the browser where it was.
					Effect.runFork(
						opener.browse(answer.folder).pipe(
							Effect.match({
								onFailure: (failure) =>
									setView(
										withRefusal(
											latest.current,
											folderUnreadable(answer.folder ?? "your home folder", failure.reason),
										),
									),
								onSuccess: (listing) => {
									const at = browseStep(listing.folder);
									setReadings((current) =>
										new Map(current).set(stepKey(at), {_tag: "Folder", listing}),
									);
									setView(browsing(latest.current, listing.folder));
								},
							}),
						),
					);
					return;
				}
				case "Open": {
					// One open at a time: a second Enter while the first waits on the trust prompt is the
					// same request again, not a second project.
					if (opener === null || opening !== null) return;
					setOpening({name: answer.name});
					Effect.runFork(
						opener.open(answer.folder).pipe(
							Effect.match({
								onFailure: (failure) => {
									setOpening(null);
									setView(
										withRefusal(latest.current, projectNotOpened(answer.folder, failure.reason)),
									);
								},
								onSuccess: (opened) => {
									setOpening(null);
									setView(landedOn(latest.current, opened.key, opened.name, "opened"));
								},
							}),
						),
					);
					return;
				}
				case "Ignored":
					return;
			}
		},
		[opener, opening, setView],
	);

	return {data: key === null ? LOADING : (readings.get(key) ?? LOADING), opening, run};
};
