/**
 * The shared form-submit envelope for the uniform mutation forms. See
 * `.patterns/fate-mutations-client.md`.
 *
 * NOT for the divan/profile gating sites (`CaylakDetail`, `VouchSheet`,
 * `PromotionActions`): those classify the error into a *domain outcome*
 * (`denied` on `UNAUTHORIZED` **or** `FORBIDDEN`) and do not redirect — a different
 * envelope, deliberately left out (#1421).
 */
import * as React from "react";
import {useNavigate} from "react-router";
import {useT} from "../i18n/LocaleProvider";
import type {FateWireCode} from "../lib/fateWireCodes";
import {authRedirectPath} from "../lib/returnTo";
import {codeOf} from "./wire";
import {messageForCode, type WireMessageOverrides} from "./wireMessages";

export interface MutationResult<R> {
	error?: {message: string} | null;
	result?: R;
}

export function useDraftSubmit(options: {
	overrides?: WireMessageOverrides;
	redirectPath: () => string;
}) {
	const [error, setError] = React.useState<string | null>(null);
	const [inFlight, setInFlight] = React.useState(false);
	const navigate = useNavigate();
	const t = useT();

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
				setError(messageForCode(t, codeOf(callError), options.overrides));
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
