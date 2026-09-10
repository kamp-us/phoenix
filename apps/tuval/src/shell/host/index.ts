/** The shell's Cmds run against the kernel, and the socket the page attaches over. */

export {type ShellHostServices, type WiredShellOptions, wiredShellEffects} from "./effects.ts";
export {type DeskServer, type ServeDeskOptions, serveDesk} from "./serve.ts";
