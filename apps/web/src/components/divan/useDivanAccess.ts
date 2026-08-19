/**
 * `useDivanAccess` — probes the gated `divan.roster` read to answer "may THIS user see the
 * divan?" (#1290). Imperative (`request` in an effect, not the suspending `useRequest`)
 * because it drives the topbar entry, which sits in the `Layout` shell above any `<Screen>`
 * Suspense boundary, so it must resolve to a safe default rather than suspend. Fail-closed:
 * it only probes when signed in, and any error ⇒ not granted.
 */
import {useCallback, useEffect, useState} from "react";
import {useFateClient, view} from "react-fate";
import type {DivanCaylak} from "../../../worker/features/fate/views";
import {useSession} from "../../auth/client";
import type {MeUser} from "../../auth/useMe";
import {shouldProbeDivanRoster} from "./divanGating";

const DivanAccessProbeView = view<DivanCaylak>()({id: true});
const DivanRosterProbeConnection = {items: {node: DivanAccessProbeView}} as const;

export function useDivanAccess(me: MeUser | null): boolean {
	const session = useSession();
	const fate = useFateClient();
	const [granted, setGranted] = useState(false);
	const signedIn = !!session.data;
	// Skip the probe only when denial is client-provable (#2209); the ambiguous cases (a
	// not-yet-loaded `me`, a yazar, a moderator) are still probed.
	const probeWire = shouldProbeDivanRoster(signedIn, me?.tier, me?.isModerator);

	const probe = useCallback(async () => {
		if (!probeWire) {
			setGranted(false);
			return;
		}
		try {
			await fate.request({
				"divan.roster": {list: DivanRosterProbeConnection, args: {first: 1}},
			});
			setGranted(true);
		} catch {
			// UNAUTHORIZED or a transport failure ⇒ fail closed, the entry stays hidden.
			setGranted(false);
		}
	}, [probeWire, fate]);

	useEffect(() => {
		void probe();
	}, [probe]);

	return granted;
}
