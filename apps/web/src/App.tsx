import {useEffect, useState} from "react";
import {Outlet, Route, Routes, useLocation, useNavigate, useParams} from "react-router";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {AppShell, Main} from "./components/layout/AppShell";
import {Footer} from "./components/layout/Footer";
import {Topbar} from "./components/layout/Topbar";
import {Provider as TooltipProvider} from "./components/ui/Tooltip";
import {COMMENTS, LANDING_TERMS, POSTS} from "./fixtures";
import {AuthPage} from "./pages/AuthPage";
import {LandingPage} from "./pages/LandingPage";
import {PanoFeed} from "./pages/PanoFeed";
import {PanoPostDetail} from "./pages/PanoPostDetail";
import {PanoSubmitPage} from "./pages/PanoSubmitPage";
import {ProfilePage} from "./pages/ProfilePage";
import {SozlukHome} from "./pages/SozlukHome";
import {SozlukTermPage} from "./pages/SozlukTermPage";

type Mode = "dark" | "light";

function Layout() {
	const session = useSession();
	const navigate = useNavigate();
	const location = useLocation();
	const [mode, setMode] = useState<Mode>("dark");

	useEffect(() => {
		document.documentElement.dataset.theme = mode;
	}, [mode]);

	useEffect(() => {
		if (session.data && location.pathname === "/auth") navigate("/", {replace: true});
	}, [session.data, location.pathname, navigate]);

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	const userProps = session.data?.user
		? {user: {name: session.data.user.name ?? session.data.user.email.split("@")[0] ?? "user"}}
		: {};
	const isSignedIn = !!session.data;

	return (
		<TooltipProvider>
			<AppShell>
				<Topbar
					brandName="kamp.us"
					nav={[
						{to: "/sozluk", label: "sözlük"},
						{to: "/pano", label: "pano"},
					]}
					{...userProps}
					onToggleTheme={() => setMode(mode === "dark" ? "light" : "dark")}
					onLogout={onSignOut}
					actions={
						isSignedIn ? (
							<button
								type="button"
								className="kp-topbar__btn"
								onClick={() => navigate("/pano/yeni")}
							>
								+ gönderi
							</button>
						) : (
							<button
								type="button"
								className="kp-topbar__btn"
								onClick={() => navigate("/auth")}
							>
								giriş yap
							</button>
						)
					}
				/>
				<Main>
					<Outlet />
				</Main>
				<Footer />
			</AppShell>
		</TooltipProvider>
	);
}

function PanoDetailRoute() {
	const post = POSTS[0];
	if (!post) return null;
	return <PanoPostDetail post={post} comments={COMMENTS} />;
}

function PanoSiteFeedRoute() {
	const {host} = useParams<{host: string}>();
	return <PanoFeed posts={POSTS} host={host} />;
}

export function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route path="/" element={<LandingPage posts={POSTS} terms={LANDING_TERMS} />} />
				<Route path="/pano" element={<PanoFeed posts={POSTS} />} />
				<Route path="/pano/yeni" element={<PanoSubmitPage />} />
				<Route path="/pano/site/:host" element={<PanoSiteFeedRoute />} />
				<Route path="/pano/:id" element={<PanoDetailRoute />} />
				<Route path="/sozluk" element={<SozlukHome />} />
				<Route path="/sozluk/:slug" element={<SozlukTermPage />} />
				<Route path="/auth" element={<AuthPage />} />
				<Route path="/profile" element={<ProfilePage />} />
			</Route>
		</Routes>
	);
}
