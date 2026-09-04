import {lazy} from "react";
import {consoleRegistry} from "./module-registry.ts";

consoleRegistry.register({
	id: "bayraklar",
	labelKey: "admin.module.flags",
	panel: lazy(() => import("./flags/FlagsPanel.tsx")),
});

consoleRegistry.register({
	id: "e-posta-teslimati",
	labelKey: "admin.module.emailDelivery",
	panel: lazy(() => import("./email-delivery/EmailDeliveryPanel.tsx")),
});

consoleRegistry.register({
	id: "kullanicilar",
	labelKey: "admin.module.kullanicilar",
	panel: lazy(() => import("./kullanicilar/KullanicilarPanel.tsx")),
});

export {consoleRegistry};
