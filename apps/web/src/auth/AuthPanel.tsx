import {useState} from "react";
import {SignInForm} from "./SignInForm";
import {SignUpForm} from "./SignUpForm";

type Tab = "sign-in" | "sign-up";

export function AuthPanel() {
	const [tab, setTab] = useState<Tab>("sign-in");

	return (
		<section className="auth-panel">
			<nav className="auth-tabs" aria-label="auth mode">
				<button type="button" aria-current={tab === "sign-in"} onClick={() => setTab("sign-in")}>
					sign in
				</button>
				<button type="button" aria-current={tab === "sign-up"} onClick={() => setTab("sign-up")}>
					sign up
				</button>
			</nav>
			{tab === "sign-in" ? <SignInForm /> : <SignUpForm />}
		</section>
	);
}
