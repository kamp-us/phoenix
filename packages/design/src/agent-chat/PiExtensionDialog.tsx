import {useEffect, useState} from "react";
import type {PiExtensionAnswer} from "../agent-chat-bridge";
import {Button} from "../Button";
import {Dialog} from "../Dialog";
import {Input, Textarea} from "../Form";
import {useDesignT} from "../i18n";
import type {ExtensionRequest} from "./types";
import "./PiExtensionDialog.css";
import "../visually-hidden.css";

export function PiExtensionDialog({
	request,
	onAnswer,
}: {
	readonly request: ExtensionRequest;
	readonly onAnswer: (answer: PiExtensionAnswer) => Promise<void>;
}) {
	const t = useDesignT();
	const [value, setValue] = useState(request.prefill ?? "");
	useEffect(() => setValue(request.prefill ?? ""), [request.id, request.prefill]);
	const cancel = () => void onAnswer({id: request.id, cancelled: true});
	const answer = (next: Omit<PiExtensionAnswer, "id">) => void onAnswer({id: request.id, ...next});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) cancel();
			}}
			title={request.title}
			{...(request.message ? {description: request.message} : {})}
			footer={() =>
				request.method === "confirm" ? (
					<>
						<Button variant="tertiary" onClick={cancel}>
							{t("admin.agent.extension.cancel")}
						</Button>
						<Button variant="primary" onClick={() => answer({confirmed: true})}>
							{t("admin.agent.extension.confirm")}
						</Button>
					</>
				) : request.method === "select" ? (
					<Button variant="tertiary" onClick={cancel}>
						{t("admin.agent.extension.cancel")}
					</Button>
				) : (
					<>
						<Button variant="tertiary" onClick={cancel}>
							{t("admin.agent.extension.cancel")}
						</Button>
						<Button variant="primary" onClick={() => answer({value})}>
							{t("admin.agent.extension.submit")}
						</Button>
					</>
				)
			}
		>
			{request.method === "select" ? (
				<div className="kp-agent-chat__extension-options">
					{request.options?.map((option) => (
						<Button key={option} variant="secondary" block onClick={() => answer({value: option})}>
							{option}
						</Button>
					))}
				</div>
			) : request.method === "input" ? (
				<Input
					label={<span className="kp-visually-hidden">{t("admin.agent.extension.input")}</span>}
					placeholder={request.placeholder}
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					fullWidth
				/>
			) : request.method === "editor" ? (
				<Textarea
					label={<span className="kp-visually-hidden">{t("admin.agent.extension.editor")}</span>}
					placeholder={request.placeholder}
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					rows={8}
					resize="vertical"
					fullWidth
				/>
			) : null}
		</Dialog>
	);
}
