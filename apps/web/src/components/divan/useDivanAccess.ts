/**
 * `useDivanAccess` — the server-authoritative answer to "may THIS user see the
 * divan?" (#1290). The divan is reached by yazar OR mod (the disjunctive
 * `requireDivanAccess` gate, divan/gate.ts), and the frontend carries no mod
 * signal (`role` is not on the `User` view) — so rather than guess authority
 * client-side, this probes the gated `divan.roster` read and reports whether it
 * resolved (granted) or denied (the invisible `UNAUTHORIZED`).
 *
 * Imperative (`request` in an effect, not the suspending `useRequest`), for the
 * same reason as `useMe` / `useProfileStats`: it drives the topbar entry, which
 * sits in the `Layout` shell above any `<Screen>` Suspense boundary, so it must
 * resolve to a safe default rather than suspend.
 *
 * Two guards keep it dark and fail-closed:
 *   - It only probes when the `phoenix-authorship-loop` flag is on AND the viewer
 *     is signed in. With the flag off the gated read returns an EMPTY connection
 *     (success) for everyone, so probing then would falsely "grant" a çaylak —
 *     gating the probe on the flag is what makes the flag-on denial meaningful.
 *   - Any error (the `UNAUTHORIZED` denial, or a transport failure) ⇒ not granted.
 *     The returned value ANDs the flag back in, so a stale grant can never outlive
 *     the flag.
 */
import {useCallback, useEffect, useState} from "react";
import {useFateClient, view} from "react-fate";
import type {DivanCaylak} from "../../../worker/features/fate/views";
import {useSession} from "../../auth/client";
import {PHOENIX_AUTHORSHIP_LOOP} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";

const DivanAccessProbeView = view<DivanCaylak>()({id: true});
const DivanRosterProbeConnection = {items: {node: DivanAccessProbeView}} as const;

export function useDivanAccess(): boolean {
	const {value: flagOn} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);
	const session = useSession();
	const fate = useFateClient();
	const [granted, setGranted] = useState(false);
	const signedIn = !!session.data;

	const probe = useCallback(async () => {
		if (!flagOn || !signedIn) {
			setGranted(false);
			return;
		}
		try {
			await fate.request({
				"divan.roster": {list: DivanRosterProbeConnection, args: {first: 1}},
			});
			setGranted(true);
		} catch {
			// The invisible `UNAUTHORIZED` denial (çaylak/visitor) or any transport
			// failure ⇒ no access. Fail-closed: the entry stays hidden.
			setGranted(false);
		}
	}, [flagOn, signedIn, fate]);

	useEffect(() => {
		void probe();
	}, [probe]);

	// AND the flag back in so a grant can never outlive the flag flipping off.
	return flagOn && granted;
}
