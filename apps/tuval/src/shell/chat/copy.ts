/**
 * Tuval's own English catalog for the `@kampus/design` primitives it mounts.
 *
 * The package ships a Turkish default because apps/web is a Turkish product; Tuval is not — only
 * the product names Tuval, Fabrika and Demlik are Turkish, and every noun a Tuval surface shows is
 * English (`.glossary/LANGUAGE.md`). `DesignTranslationProvider` is the package's own injection
 * point for exactly this, so nothing here reaches inside a component.
 *
 * The map is a total `Record<DesignCatalogKey, string>` rather than a partial override, so a key
 * added to the package's catalog is a compile error here instead of one Turkish string appearing
 * inside an otherwise-English window.
 *
 * `AgentChatInput`'s default copy names Pi throughout. Tuval's composer renders whichever agent the
 * window's process runs, so every one of those lines says "the agent" — a window that named a
 * backend would stop being the one renderer both agent programs bind.
 */

import type {DesignCatalogKey, DesignTranslate} from "@kampus/design";

const messages: Readonly<Record<DesignCatalogKey, string>> = {
	"ui.caylakBadge": "newcomer contribution",
	"ui.caylakBadge.stage": ", in preparation",
	"ui.reviewBadge": "in review",
	"ui.edited": "edited",
	"ui.share.label": "share",
	"ui.share.copied": "copied",
	"ui.share.error": "could not copy",
	"ui.report.action": "report",
	"ui.report.reported": "reported",
	"ui.report.already": "already reported",
	"ui.draftRestore.label": "saved draft",
	"ui.draftRestore.text": "You have a saved draft. Restore it?",
	"ui.draftRestore.restore": "restore the draft",
	"ui.draftRestore.dismiss": "dismiss",
	"admin.agent.label": "Agent composer",
	"admin.agent.scope": "this window only",
	"admin.agent.compose.label": "Write a message to the agent",
	"admin.agent.compose.placeholder": "Tell the agent what to do…",
	"admin.agent.completions": "Completions",
	"admin.agent.attachments": "Image attachments",
	"admin.agent.attachment.remove": "Remove the image {name}",
	"admin.agent.image.add": "Add an image",
	"admin.agent.settings": "Agent settings",
	"admin.agent.picker.loading": "loading",
	"admin.agent.setting.model": "model",
	"admin.agent.setting.thinking": "thinking effort",
	"admin.agent.select.model": "Agent model",
	"admin.agent.select.thinking": "Agent thinking effort",
	"admin.agent.select.trust":
		"Project permission. Trust loads local project resources; ignore turns them off.",
	"admin.agent.select.delivery": "Delivery mode",
	"admin.agent.resources": "resources",
	"admin.agent.resources.label": "Project resources and delivery settings",
	"admin.agent.menu.streaming": "sending while running",
	"admin.agent.menu.projectResources": "project resources",
	"admin.agent.trust.load": "load resources",
	"admin.agent.trust.skip": "skip resources",
	"admin.agent.trust.approve": "trust",
	"admin.agent.trust.ignore": "ignore",
	"admin.agent.delivery.prompt": "send",
	"admin.agent.delivery.steer": "steer",
	"admin.agent.delivery.followUp": "queue",
	"admin.agent.thinking.off": "off",
	"admin.agent.thinking.minimal": "minimal",
	"admin.agent.thinking.low": "low",
	"admin.agent.thinking.medium": "medium",
	"admin.agent.thinking.high": "high",
	"admin.agent.thinking.xhigh": "very high",
	"admin.agent.thinking.max": "maximum",
	"admin.agent.stop": "stop",
	"admin.agent.send": "send",
	"admin.agent.queue": "queue",
	"admin.agent.status.loading": "Looking for the agent…",
	"admin.agent.status.working": "The agent is working",
	"admin.agent.status.ready": "The agent is ready",
	"admin.agent.status.readyWithModel": "The agent is ready · {model}",
	"admin.agent.status.unavailable": "The agent is unavailable",
	"admin.agent.hint.send": "send",
	"admin.agent.hint.newline": "new line",
	"admin.agent.hint.command": "command",
	"admin.agent.hint.file": "file",
	"admin.agent.hint.pasteImage": "paste an image",
	"admin.agent.hint.addOrPasteImage": "add or paste an image",
	"admin.agent.inspector": "Inspector",
	"admin.agent.activity.title": "activity",
	"admin.agent.activity.empty": "The agent's replies and tool activity show up here.",
	"admin.agent.activity.started": "The agent started working.",
	"admin.agent.activity.settled": "The agent finished the turn.",
	"admin.agent.activity.tool": "The agent is using {tool}.",
	"admin.agent.activity.toolFallback": "a tool",
	"admin.agent.activity.steered": "The prompt was queued as a steer for the running turn.",
	"admin.agent.activity.prompted": "The prompt was sent to the agent.",
	"admin.agent.activity.steerQueued": "The steer was queued.",
	"admin.agent.activity.followUpQueued": "The next prompt was queued.",
	"admin.agent.activity.stopped": "The agent received the stop request.",
	"admin.agent.activity.modelChanged": "The agent model changed to {model}.",
	"admin.agent.activity.thinkingChanged": "The agent thinking effort changed to {level}.",
	"admin.agent.activity.trustLoaded": "The agent restarted and will load project resources.",
	"admin.agent.activity.trustSkipped": "The agent restarted and will ignore project resources.",
	"admin.agent.mock.prompted": "The prompt went to the mock harness.",
	"admin.agent.mock.reply": "This is a mock reply for trying the composer out.",
	"admin.agent.mock.stopped": "The mock turn was stopped.",
	"admin.agent.mock.modelChanged": "The mock model changed to {model}.",
	"admin.agent.mock.thinkingChanged": "The mock thinking effort changed to {level}.",
	"admin.agent.mock.trustLoaded": "Mock project resources were loaded.",
	"admin.agent.mock.trustSkipped": "Mock project resources were ignored.",
	"admin.agent.mock.command.review": "Review the changes.",
	"admin.agent.mock.command.compact": "Compact the session context.",
	"admin.agent.imageOnlyPrompt": "Take a look at this image.",
	"admin.agent.extension.title": "Agent extension",
	"admin.agent.extension.input": "Agent extension answer",
	"admin.agent.extension.editor": "Agent extension text",
	"admin.agent.extension.cancel": "cancel",
	"admin.agent.extension.confirm": "confirm",
	"admin.agent.extension.submit": "submit",
	"admin.agent.error.connect": "Could not reach the agent.",
	"admin.agent.error.send": "The prompt could not be sent.",
	"admin.agent.error.stop": "The agent could not be stopped.",
	"admin.agent.error.model": "The agent model could not be changed.",
	"admin.agent.error.thinking": "The agent thinking effort could not be changed.",
	"admin.agent.error.trust": "The project permission could not be changed.",
	"admin.agent.error.imagesOnly": "This transport accepts image attachments only.",
	"admin.agent.error.imageTooLarge": "An image must be smaller than 5 MB.",
	"admin.agent.error.imageRead": "The image could not be read.",
	"admin.agent.error.imageAdd": "The image could not be added.",
	"admin.agent.error.extension": "The agent extension could not be answered.",
};

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The package's `{name}` substitution, over this map. The package's own translate closes over its
 * Turkish table and is not exported, so the substitution is re-stated here; `copy.unit.test.ts`
 * pins that a parameterised key still interpolates and that an unknown parameter is left alone.
 */
export const tuvalDesignTranslate: DesignTranslate = (key, params) => {
	const message = messages[key];
	if (!params) return message;
	return message.replace(PLACEHOLDER, (whole, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : whole,
	);
};

/** The table itself, so a test can walk every key the package declares. */
export const tuvalDesignMessages = messages;
