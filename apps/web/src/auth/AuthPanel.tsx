import {useState} from "react";
import {Tabs} from "../components/ui/Tabs";
import {SignInForm} from "./SignInForm";
import {SignUpForm} from "./SignUpForm";

type Mode = "sign-in" | "sign-up";

export function AuthPanel() {
	const [mode, setMode] = useState<Mode>("sign-in");

	return (
		<Tabs.Root variant="pill" value={mode} onValueChange={(v) => setMode(v as Mode)}>
			<Tabs.List>
				<Tabs.Tab value="sign-in">giriş</Tabs.Tab>
				<Tabs.Tab value="sign-up">kayıt</Tabs.Tab>
			</Tabs.List>
			<Tabs.Panel value="sign-in" style={{paddingTop: "var(--s-3)"}}>
				<SignInForm />
			</Tabs.Panel>
			<Tabs.Panel value="sign-up" style={{paddingTop: "var(--s-3)"}}>
				<SignUpForm />
			</Tabs.Panel>
		</Tabs.Root>
	);
}
