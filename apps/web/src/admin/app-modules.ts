/**
 * The app-wide console module composition (#2740, epic #2711) — where the real console
 * modules register into `consoleRegistry` BY VALUE, the client mirror of the worker-side
 * `config.ts` `modules` array. Imported by the lazy console shell only, so no module code
 * reaches a non-admin's bundle; each module's panel is itself `React.lazy`-wrapped, so a
 * module's panel chunk loads only when its nav entry is selected.
 *
 * Registering a module is one entry here. The flags module (#2742) is the first real tenant —
 * its `bayraklar` panel writes the `phoenix_flag_overrides` cookie per-browser.
 */
import {lazy} from "react";
import {consoleRegistry} from "./module-registry.ts";

consoleRegistry.register({
	id: "bayraklar",
	label: "özellik bayrakları",
	panel: lazy(() => import("./flags/FlagsPanel.tsx")),
});

consoleRegistry.register({
	id: "e-posta-teslimati",
	label: "e-posta teslimatı",
	panel: lazy(() => import("./email-delivery/EmailDeliveryPanel.tsx")),
});

consoleRegistry.register({
	id: "kullanicilar",
	label: "kullanıcılar",
	panel: lazy(() => import("./kullanicilar/KullanicilarPanel.tsx")),
});

export {consoleRegistry};
