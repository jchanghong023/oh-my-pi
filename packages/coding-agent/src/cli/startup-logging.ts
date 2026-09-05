import { logger } from "@oh-my-pi/pi-utils";
import type { Args } from "./args";

/** Called after argv parsing and profile selection; leaves explicit transports alone by default. */
export function configureStartupLogging(args: Pick<Args, "logFile">): void {
	if (args.logFile) logger.setTransports({ file: true, console: false });
}
