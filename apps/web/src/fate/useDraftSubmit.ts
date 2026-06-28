/**
 * The shared form-submit envelope, lifted out of `PanoPostDetail` (#1421) so the
 * uniform mutation forms (pano submit/save-draft, sözlük definition add/edit/delete,
 * pano post edit/delete + comments) no longer hand-roll the same try/catch. It is
 * the write-side analogue of {@link useVoteToggle}'s already-lifted toggle envelope.
 *
 * The envelope: flip `inFlight`, fire the mutation, map a returned `{error}` to its
 * inline message via the shared {@link messageForCode} registry, redirect to auth on
 * an `UNAUTHORIZED` boundary throw, and fall any other throw back to the surface's
 * generic `failureFallback`. See `.patterns/fate-mutations-client.md`.
 *
 * NOT for the divan/profile gating sites (`CaylakDetail`, `VouchSheet`,
 * `PromotionActions`): those classify the error into a *domain outcome*
 * (`denied` on `UNAUTHORIZED` **or** `FORBIDDEN`) and do not redirect — a different
 * envelope, deliberately left out (#1421).
 */
import * as React from "react";
import {useNavigate} from "react-router";
import type {FateWireCode} from "../lib/fateWireCodes";
import {authRedirectPath} from "../lib/returnTo";
import {codeOf} from "./wire";
import {messageForCode, type WireMessageOverrides} from "./wireMessages";

/** The shape a fate mutation call resolves to: an optional `{error}` plus its result. */
export interface MutationResult<R> {
	error?: {message: string} | null;
	result?: R;
}

/**
 * The "in-flight + error + UNAUTHORIZED-redirect" submit envelope. `run` flips
 * `inFlight`, maps a returned wire error through `overrides`/the shared registry,
 * and on an `UNAUTHORIZED` throw navigates to the auth redirect. `redirectPath`
 * is the post-auth return path; `overrides` is the surface's per-code copy.
 */
export function useDraftSubmit(options: {
	overrides?: WireMessageOverrides;
	redirectPath: () => string;
}) {
	const [error, setError] = React.useState<string | null>(null);
	const [inFlight, setInFlight] = React.useState(false);
	const navigate = useNavigate();

	const run = async <R>(
		mutate: () => Promise<MutationResult<R>>,
		failureFallback: string,
		onSuccess: (result: R | undefined) => void | Promise<void>,
	) => {
		setError(null);
		setInFlight(true);
		try {
			const {error: callError, result} = await mutate();
			if (callError) {
				setError(messageForCode(codeOf(callError), options.overrides));
				return;
			}
			await onSuccess(result);
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath(options.redirectPath()));
				return;
			}
			// An unexpected boundary throw is not a per-code validation message: a
			// named override still wins (a thrown validation code stays specific),
			// else the surface's generic "operation failed" line.
			setError(options.overrides?.[code] ?? failureFallback);
		} finally {
			setInFlight(false);
		}
	};

	return {error, setError, inFlight, run};
}

/**
 * Single-body draft composer (validated textarea over the {@link useDraftSubmit}
 * envelope), used by the comment add/edit forms. `validate` returns one of the
 * surface's inline messages or `null`; messages are not restated here.
 */
export function useDraft(options: {
	initialBody: string;
	validate: (trimmed: string, body: string) => string | null;
	redirectPath: () => string;
	run: (body: string) => Promise<{error?: {message: string} | null}>;
	overrides?: WireMessageOverrides;
	failureFallback: string;
	onSuccess: () => void;
}) {
	const [body, setBody] = React.useState(options.initialBody);
	const {error, setError, inFlight, run} = useDraftSubmit({
		overrides: options.overrides,
		redirectPath: options.redirectPath,
	});

	const submit = async (e: React.SyntheticEvent) => {
		e.preventDefault();
		const trimmed = body.trim();
		const validationError = options.validate(trimmed, body);
		if (validationError != null) {
			setError(validationError);
			return;
		}
		await run(() => options.run(body), options.failureFallback, options.onSuccess);
	};

	return {body, setBody, error, setError, inFlight, submit};
}

export type {FateWireCode};
