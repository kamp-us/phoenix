import {useRef, useState} from "react";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Card} from "../../../../apps/web/src/components/ui/Card.js";
import {Form, Input} from "../../../../apps/web/src/components/ui/Form.js";
import type {ControlLiveSessionOutcome} from "../shared/live-session.js";

export interface SessionLaunchControlsProps {
	readonly onCreate: (cwd: string) => Promise<ControlLiveSessionOutcome>;
	readonly onOpen: (sessionId: string) => Promise<ControlLiveSessionOutcome>;
	readonly createAvailable?: boolean;
	readonly openAvailable?: boolean;
}

type PendingLaunch = "create" | "open" | null;

const failureCopy = (action: "Oluşturma" | "Açma", outcome: ControlLiveSessionOutcome): string =>
	outcome._tag === "refused"
		? `${action} başarısız (${outcome.code}): ${outcome.reason}`
		: `${action} pi tarafından onaylandı.`;

export function SessionLaunchControls({
	onCreate,
	onOpen,
	createAvailable = true,
	openAvailable = true,
}: SessionLaunchControlsProps) {
	const [cwd, setCwd] = useState("");
	const [sessionId, setSessionId] = useState("");
	const [pending, setPending] = useState<PendingLaunch>(null);
	const [status, setStatus] = useState<{readonly danger: boolean; readonly text: string} | null>(
		null,
	);
	const createInput = useRef<HTMLInputElement>(null);
	const openInput = useRef<HTMLInputElement>(null);

	const run = async (
		action: Exclude<PendingLaunch, null>,
		value: string,
		request: (value: string) => Promise<ControlLiveSessionOutcome>,
	): Promise<void> => {
		if (pending !== null || value.trim().length === 0) return;
		setPending(action);
		setStatus({
			danger: false,
			text: action === "create" ? "Oluşturma onayı bekleniyor." : "Açma onayı bekleniyor.",
		});
		try {
			const outcome = await request(value.trim());
			setStatus({
				danger: outcome._tag === "refused",
				text: failureCopy(action === "create" ? "Oluşturma" : "Açma", outcome),
			});
			if (outcome._tag === "acknowledged") {
				if (action === "create") setCwd("");
				else setSessionId("");
			}
		} catch (error) {
			setStatus({
				danger: true,
				text: `${action === "create" ? "Oluşturma" : "Açma"} başarısız (protocol): ${
					error instanceof Error ? error.message : "Denetim yanıtı alınamadı."
				}`,
			});
		} finally {
			setPending(null);
			requestAnimationFrame(() =>
				requestAnimationFrame(() =>
					(action === "create" ? createInput.current : openInput.current)?.focus(),
				),
			);
		}
	};

	if (!createAvailable && !openAvailable) return null;
	return (
		<Card as="section" className="session-launch" aria-label="Oturum oluşturma ve açma">
			<p className="session-launch__eyebrow">Oturum denetimleri</p>
			{createAvailable ? (
				<Form
					className="session-launch__form"
					onSubmit={(event) => {
						event.preventDefault();
						void run("create", cwd, onCreate);
					}}
				>
					<Input
						ref={createInput}
						label="Çalışma dizini"
						value={cwd}
						onChange={(event) => setCwd(event.currentTarget.value)}
						disabled={pending !== null}
					/>
					<Button type="submit" variant="primary" disabled={pending !== null || cwd.trim() === ""}>
						{pending === "create" ? "Oluşturuluyor" : "Yeni oturum"}
					</Button>
				</Form>
			) : null}
			{openAvailable ? (
				<Form
					className="session-launch__form"
					onSubmit={(event) => {
						event.preventDefault();
						void run("open", sessionId, onOpen);
					}}
				>
					<Input
						ref={openInput}
						label="Oturum kimliği"
						value={sessionId}
						onChange={(event) => setSessionId(event.currentTarget.value)}
						disabled={pending !== null}
					/>
					<Button
						type="submit"
						variant="secondary"
						disabled={pending !== null || sessionId.trim() === ""}
					>
						{pending === "open" ? "Açılıyor" : "Oturumu aç"}
					</Button>
				</Form>
			) : null}
			{status === null ? null : (
				<p
					className="control-status"
					data-tone={status.danger ? "danger" : pending === null ? "ready" : "loading"}
					role={status.danger ? "alert" : "status"}
					aria-live={status.danger ? "assertive" : "polite"}
				>
					{status.text}
				</p>
			)}
		</Card>
	);
}
