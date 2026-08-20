import {createContext, lazy, Suspense, useContext, useEffect, useMemo, useState} from "react";
import {
	Navigate,
	Outlet,
	Route,
	Routes,
	useLocation,
	useMatch,
	useNavigate,
	useParams,
} from "react-router";
import {AdminConsoleRoute} from "./admin/AdminConsoleRoute";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {useMe} from "./auth/useMe";
import {useBildirimUnread} from "./components/bildirim/useBildirimUnread";
import {DivanSubnavLayout} from "./components/divan/DivanSubnavLayout";
import {useDivanAccess} from "./components/divan/useDivanAccess";
import {AppShell, Main} from "./components/layout/AppShell";
import {Footer} from "./components/layout/Footer";
import {Topbar} from "./components/layout/Topbar";
import {MecmuaSubnavLayout} from "./components/mecmua/MecmuaSubnavLayout";
import {EmailDeliveryNoticeMount} from "./components/membrane/EmailDeliveryNoticeMount";
import {actorLabel} from "./components/moderation/actor-identity";
import {PanoSubnavLayout} from "./components/pano/PanoSubnavLayout";
import {EagerProfileContributionSkeleton} from "./components/profile/ProfileContributionSignal";
import {SozlukCreateDialogProvider} from "./components/sozluk/SozlukCreateDialogState";
import {SozlukSubnavLayout} from "./components/sozluk/SozlukSubnavLayout";
import {Button} from "./components/ui/Button";
import {ToastProvider} from "./components/ui/Toast";
import {Provider as TooltipProvider} from "./components/ui/Tooltip";
import {FateProvider, PublicFateProvider} from "./fate/FateProvider";
import {teardownAuthedSnapshot} from "./fate/snapshot";
import {readBootUser} from "./flags/boot";
import {EdgeShellBootMarker} from "./flags/EdgeShellBoot";
import {MECMUA_PUBLIC_READ, PHOENIX_BILDIRIM} from "./flags/keys";
import {useFlag} from "./flags/useFlag";
import {AtolyeExhibitPage} from "./lab/atolye/AtolyeExhibitPage";
import {AtolyeIndexPage} from "./lab/atolye/AtolyeIndexPage";
import {DensityProvider} from "./lib/density";
import {SAVED_HREF} from "./lib/panoNav";
import {safeReturnTo} from "./lib/returnTo";
import {searchTarget} from "./lib/searchTarget";
import {ThemeProvider, useTheme} from "./lib/theme";
import {AuthPage} from "./pages/AuthPage";
import {BildirimlerPage} from "./pages/BildirimlerPage";
import {CAYLAK_VISIBILITY_PATH, CaylakVisibilityPage} from "./pages/CaylakVisibilityPage";
import {DivanPage} from "./pages/DivanPage";
import {FunnelPage} from "./pages/FunnelPage";
import {LandingPage} from "./pages/LandingPage";
import {MecmuaDraftsPage} from "./pages/MecmuaDraftsPage";
import {MecmuaFeedPage} from "./pages/MecmuaFeedPage";
import {MecmuaIndexPage} from "./pages/MecmuaIndexPage";
import {MecmuaPostPage} from "./pages/MecmuaPostPage";
import {MutesPage} from "./pages/MutesPage";
import {NotFoundPage} from "./pages/NotFoundPage";
import {PanoFeed} from "./pages/PanoFeed";
import {PanoPostDetail} from "./pages/PanoPostDetail";
import {PanoSubmitPage} from "./pages/PanoSubmitPage";
import {ProfilePage} from "./pages/ProfilePage";
import {SearchPage} from "./pages/SearchPage";
import {SozlukHome} from "./pages/SozlukHome";
import {SozlukTermPage} from "./pages/SozlukTermPage";
import {useUsernameResolutionPending} from "./pages/signupUsernameGate";
import {UsernameBootstrap} from "./pages/UsernameBootstrap";
import {UserProfilePage} from "./pages/UserProfilePage";
import {useProfileStats} from "./pages/useProfileStats";

type TopbarChips = {
	userProps: {user?: {name: string; username: string | null}};
	karma: number | undefined;
	divanTo: string | undefined;
	bildirim: {to: string; unread: number} | undefined;
};

// Carries the chips UP from `LayoutContent` (below the session gate) to the shell frame
// above it, so the frame renders once and only the chips fill in on settle (#2160).
const SetTopbarChipsContext = createContext<((chips: TopbarChips | null) => void) | null>(null);

/**
 * The always-painting shell frame. It reads only `useSession`/`useTheme`/routing —
 * NO fate client — so it renders on the first frame, before `/api/auth/get-session`
 * resolves, killing the blank first-paint flash (#2160). The fate-dependent chips
 * arrive later via the chip-state bridge, set by `LayoutContent` from below the
 * session gate; until then the topbar shows its signed-out/anonymous affordances.
 * The signed-in/out `actions` split rides `useSession` alone, so it is correct
 * immediately without waiting on fate.
 */
function Layout() {
	const session = useSession();
	const navigate = useNavigate();
	const location = useLocation();
	const {choice: themeChoice, setChoice: setThemeChoice} = useTheme();
	const [chips, setChips] = useState<TopbarChips | null>(null);
	// mecmua-public-read (#2512) resolves synchronously from `window.__BOOT__` so the nav paints
	// its final geometry on the first frame; absent `__BOOT__` it falls back to the fetch. See ADR 0179.
	const {value: mecmuaOn} = useFlag(MECMUA_PUBLIC_READ, false);

	// Eager public-tier pano feed above the session gate — see ADR 0167. The public client is a
	// distinct, never-re-keyed instance, so the authed tree still mounts exactly once (#438).
	const panoMatch = useMatch("/pano");
	const panoSiteMatch = useMatch("/pano/site/:host");
	const eagerPanoHost = panoSiteMatch?.params.host;
	const showEagerPanoFeed = session.isPending && (panoMatch != null || panoSiteMatch != null);

	// The same two-tier decoupling for `/profile` (#2188) — see ADR 0167; why it is a skeleton
	// rather than anon data lives on `EagerProfileContributionSkeleton`.
	const profileMatch = useMatch("/profile");
	const showEagerProfileSkeleton = session.isPending && profileMatch != null;

	const searchQuery =
		location.pathname === "/search" ? (new URLSearchParams(location.search).get("q") ?? "") : "";

	async function onSignOut() {
		// Drop this identity's persisted feed snapshot at the sign-out seam BEFORE the
		// session clears — its private myVote/isSaved overlay must not outlive the session
		// (#2321). Capture the id first: signOut() nulls the session. The FateProvider
		// identity-change seam also tears down on the resulting A→anon transition; this
		// eager call makes the removal immediate on click rather than after the async settle.
		const signedOutUserId = session.data?.user.id;
		if (signedOutUserId) teardownAuthedSnapshot(signedOutUserId);
		await authClient.signOut();
		clearBearerToken();
	}

	const isSignedIn = !!session.data;
	// First-paint identity rides the edge-resolved `__BOOT__.user` — see ADR 0185. Absent
	// `__BOOT__` this is null and the session-gated `isSignedIn` governs.
	const bootUser = readBootUser();
	const bootSignedIn = bootUser != null;
	const signedInAtFirstPaint = bootSignedIn || isSignedIn;
	// Reserve the account slot only while the edge said signed-in AND we haven't settled to a
	// definitively signed-out session — so an absent `__BOOT__` never reserves (today's render)
	// and a boot/session divergence collapses cleanly rather than stranding a phantom slot.
	const reserveSignedInSlots = bootSignedIn && (session.isPending || isSignedIn);
	const bootUserProps = bootUser
		? {
				user: {
					name: actorLabel(bootUser.name, bootUser.username, "kullanıcı"),
					username: bootUser.username,
				},
			}
		: {};

	return (
		<TooltipProvider>
			<ToastProvider>
				{/* The sözlük create-dialog open-state lives here, above `FateProvider`'s
				    `key={userId}` re-key and `LayoutContent`'s `needsBootstrap` Outlet swap, so
				    an ancestor unmount can't silently destroy it — the #3840 hoist. The CTA reads
				    it through context far below, the same bridge shape as `SetTopbarChipsContext`. */}
				<SozlukCreateDialogProvider>
					<AppShell>
						{/* boot-mode observer for the edge-resolved shell (ADR 0179) — geometry-inert */}
						<EdgeShellBootMarker />
						<Topbar
							brandName="kamp.us"
							reserveSignedInSlots={reserveSignedInSlots}
							// akış is a mecmua SUB-destination living in the mecmua Subnav zone (#2603),
							// so the topbar carries just the `mecmua` product noun — a cross-product
							// destination, per placement law #2587.
							nav={[
								{to: "/sozluk", label: "sözlük"},
								{to: "/pano", label: "pano"},
								...(mecmuaOn ? [{to: "/mecmua", label: "mecmua"}] : []),
							]}
							divanTo={chips?.divanTo}
							{...(chips?.userProps ?? bootUserProps)}
							karma={chips?.karma}
							{...(chips?.bildirim ? {bildirim: chips.bildirim} : {})}
							searchQuery={searchQuery}
							onSearchSubmit={(query) => {
								const target = searchTarget(query);
								if (target) navigate(target);
							}}
							// No `onToggleTheme`: the three-way theme picker is the sole theme control
							// (#2612), so no tema button renders.
							themeChoice={themeChoice}
							onThemeChange={setThemeChoice}
							onLogout={onSignOut}
							actions={
								// Suppressed from the first frame for a signed-in user so the CTA never flashes
								// then swaps out (#2933) — see ADR 0185.
								!signedInAtFirstPaint ? (
									<Button
										type="button"
										variant="secondary"
										size="sm"
										className="kp-topbar__btn"
										onClick={() => navigate("/auth")}
									>
										giriş yap
									</Button>
								) : null
								// Signed in ⇒ no topbar action: pano's `+ gönderi` primary action lives in
								// the pano Subnav CTA zone (placement law #2587), not the topbar.
							}
						/>
						<Main>
							{showEagerPanoFeed ? (
								<PublicFateProvider>
									<PanoFeed {...(eagerPanoHost ? {host: eagerPanoHost} : {})} />
								</PublicFateProvider>
							) : null}
							{showEagerProfileSkeleton ? <EagerProfileContributionSkeleton /> : null}
							<FateProvider>
								<SetTopbarChipsContext.Provider value={setChips}>
									<LayoutContent />
								</SetTopbarChipsContext.Provider>
							</FateProvider>
						</Main>
						<Footer />
					</AppShell>
				</SozlukCreateDialogProvider>
			</ToastProvider>
		</TooltipProvider>
	);
}

// Runs below `FateProvider`, which commits only once the session is settled — so this never
// mounts under an "anon" key (#438).
function LayoutContent() {
	const session = useSession();
	const {me, refetch} = useMe();
	const navigate = useNavigate();
	const location = useLocation();
	const setChips = useContext(SetTopbarChipsContext);
	const karmaState = useProfileStats(me?.username ?? null);
	const selfKarma = karmaState.status === "ok" ? karmaState.stats.totalKarma : undefined;
	// The yazar/mod-only divan entry (#1290). `useDivanAccess` probes the server's
	// gated read (yazar OR mod), so the entry is server-authoritative — invisible to
	// çaylak/visitor. `me` feeds the #2209 client short-circuit: a provably-denied
	// çaylak/non-mod skips the guaranteed-`UNAUTHORIZED` probe; the ambiguous case
	// still probes.
	const showDivan = useDivanAccess(me);
	const {value: bildirimOn} = useFlag(PHOENIX_BILDIRIM, false);
	const bildirimUnread = useBildirimUnread(bildirimOn && !!session.data, me?.id ?? null);
	// #1888: hold the off-/auth redirect while a chosen-username signup is still
	// resolving. `signUp.email` establishes the session before the separate
	// `setUsername` lands; without this hold the redirect unmounts AuthPage and
	// buries a setUsername failure, silently dropping the chosen handle into the
	// email-prefill bootstrap.
	const usernamePending = useUsernameResolutionPending();

	useEffect(() => {
		if (!session.data) return;
		if (location.pathname !== "/auth") return;
		if (usernamePending) return;
		const params = new URLSearchParams(location.search);
		const target = safeReturnTo(params.get("returnTo"));
		navigate(target, {replace: true});
	}, [session.data, location.pathname, location.search, navigate, usernamePending]);

	const sessionUser = session.data?.user;
	const username = me?.username ?? null;
	const isSignedIn = !!session.data;
	const needsBootstrap = isSignedIn && me !== null && !me.username && location.pathname !== "/auth";

	const chips = useMemo<TopbarChips>(
		() => ({
			userProps: sessionUser
				? {
						user: {
							name: actorLabel(me?.name ?? sessionUser.name, username, "kullanıcı"),
							username,
						},
					}
				: {},
			karma: selfKarma,
			divanTo: showDivan ? "/divan" : undefined,
			bildirim: bildirimOn && isSignedIn ? {to: "/bildirimler", unread: bildirimUnread} : undefined,
		}),
		[sessionUser, me?.name, username, selfKarma, showDivan, bildirimOn, isSignedIn, bildirimUnread],
	);

	useEffect(() => {
		setChips?.(chips);
		return () => setChips?.(null);
	}, [chips, setChips]);

	return (
		<>
			<EmailDeliveryNoticeMount me={me} />
			{needsBootstrap && sessionUser ? (
				<UsernameBootstrap email={sessionUser.email} onComplete={refetch} />
			) : (
				<Outlet />
			)}
		</>
	);
}

function PanoSiteFeedRoute() {
	const {host} = useParams<{host: string}>();
	return <PanoFeed {...(host ? {host} : {})} />;
}

// The composer routes are the SPA's only `@kampus/composer` (tiptap/ProseMirror) consumers,
// so lazy-loading both keeps that heavy editor payload out of the entry chunk every public
// route pays for — the performance-pillar fix of #2523. Named-export → default shim for React.lazy.
const LabComposerPage = lazy(() =>
	import("./pages/LabComposerPage").then((m) => ({default: m.LabComposerPage})),
);
const MecmuaEditorPage = lazy(() =>
	import("./pages/MecmuaEditorPage").then((m) => ({default: m.MecmuaEditorPage})),
);

function ComposerRouteFallback() {
	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<p>yükleniyor…</p>
			</div>
		</div>
	);
}

export function App() {
	const panoRoutes = [
		<Route key="pano" path="/pano" element={<PanoFeed />} />,
		<Route key="pano-yeni" path="/pano/yeni" element={<PanoSubmitPage />} />,
		<Route key="pano-site" path="/pano/site/:host" element={<PanoSiteFeedRoute />} />,
		// kaydedilenler folded into PanoFeed as the `?sort=saved` variant (#2196); the
		// legacy bespoke route redirects so existing links don't break.
		<Route
			key="pano-saved"
			path="/pano/kaydedilenler"
			element={<Navigate to={SAVED_HREF} replace />}
		/>,
		<Route key="pano-detail" path="/pano/:id" element={<PanoPostDetail />} />,
	];
	// mecmua — each page self-gates on its flag (off ⇒ 404), so these routes are dark by
	// default: the public index (#2512) + reader (#2498) on mecmua-public-read, the
	// subscribed-author feed (#2500) on mecmua-feed, the authoring page (#2499), the
	// id-addressable draft load + the drafts list (#2544) on mecmua-write. The
	// static/`yaz`-prefixed paths out-rank the `/mecmua/:slug` reader.
	const mecmuaRoutes = [
		<Route key="mecmua" path="/mecmua" element={<MecmuaIndexPage />} />,
		<Route key="mecmua-akis" path="/mecmua/akis" element={<MecmuaFeedPage />} />,
		<Route key="mecmua-yazilarim" path="/mecmua/yazilarim" element={<MecmuaDraftsPage />} />,
		<Route
			key="mecmua-yaz"
			path="/mecmua/yaz"
			element={
				<Suspense fallback={<ComposerRouteFallback />}>
					<MecmuaEditorPage />
				</Suspense>
			}
		/>,
		<Route
			key="mecmua-yaz-id"
			path="/mecmua/yaz/:id"
			element={
				<Suspense fallback={<ComposerRouteFallback />}>
					<MecmuaEditorPage />
				</Suspense>
			}
		/>,
		<Route key="mecmua-slug" path="/mecmua/:slug" element={<MecmuaPostPage />} />,
	];
	const sozlukRoutes = [
		<Route key="sozluk" path="/sozluk" element={<SozlukHome />} />,
		<Route key="sozluk-slug" path="/sozluk/:slug" element={<SozlukTermPage />} />,
	];
	const divanRoutes = [<Route key="divan" path="/divan" element={<DivanPage />} />];
	return (
		<ThemeProvider>
			<DensityProvider>
				<Routes>
					<Route element={<Layout />}>
						<Route path="/" element={<LandingPage />} />
						<Route key="pano-zone" element={<PanoSubnavLayout />}>
							{panoRoutes}
						</Route>
						<Route key="mecmua-zone" element={<MecmuaSubnavLayout />}>
							{mecmuaRoutes}
						</Route>
						<Route key="sozluk-zone" element={<SozlukSubnavLayout />}>
							{sozlukRoutes}
						</Route>
						<Route key="divan-zone" element={<DivanSubnavLayout />}>
							{divanRoutes}
						</Route>
						<Route path="/search" element={<SearchPage />} />
						<Route path="/auth" element={<AuthPage />} />
						<Route path="/funnel" element={<FunnelPage />} />
						<Route path="/bildirimler" element={<BildirimlerPage />} />
						{/* /lab/composer — throwaway tiptap spike (#2465), reachable by URL only,
						    no nav entry; deletable when the rich-composer phase begins. */}
						<Route
							path="/lab/composer"
							element={
								<Suspense fallback={<ComposerRouteFallback />}>
									<LabComposerPage />
								</Suspense>
							}
						/>
						<Route path="/lab/atolye" element={<AtolyeIndexPage />} />
						<Route path="/lab/atolye/:exhibit" element={<AtolyeExhibitPage />} />
						<Route path="/profile" element={<ProfilePage />} />
						<Route path="/susturduklarim" element={<MutesPage />} />
						{/* The yazar's çaylak in-place visibility setting (#6426) — beside the other
						    per-member preference routes; self-404s behind phoenix-caylak-visibility. */}
						<Route path={CAYLAK_VISIBILITY_PATH} element={<CaylakVisibilityPage />} />
						<Route path="/u/:username" element={<UserProfilePage />} />
						{/* The admin console (#2740, epic #2711) — the route element self-gates on
						    the server-authoritative admin probe (denied ⇒ the ordinary not-found
						    page, invisible-denial), and the console chunk is lazy-imported only past
						    the gate, so the route ships no console code to a non-admin. */}
						<Route path="/admin" element={<AdminConsoleRoute />} />
						<Route path="*" element={<NotFoundPage />} />
					</Route>
				</Routes>
			</DensityProvider>
		</ThemeProvider>
	);
}
