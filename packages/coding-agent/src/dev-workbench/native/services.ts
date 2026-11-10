import { logger } from "@oh-my-pi/pi-utils";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { createAgentServices } from "./services-agent";
import { createExtensionServices } from "./services-extensions";
import { createFileServices } from "./services-files";
import { createProjectServices } from "./services-projects";
import { createUiServices } from "./services-ui";

/** One disposable channel catalog per browser, observing the project's same native session. */
export function createWebGuiServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	const services: WebGuiServiceDefinition[] = [];
	const names = new Set<string>();
	try {
		for (const factory of [
			createUiServices,
			createProjectServices,
			createAgentServices,
			createFileServices,
			createExtensionServices,
		]) {
			const catalog = factory(context);
			services.push(...catalog);
			for (const service of catalog) {
				if (names.has(service.name)) throw new Error(`Duplicate WebGUI channel: ${service.name}`);
				names.add(service.name);
			}
		}
		return services;
	} catch (error) {
		try {
			disposeWebGuiServices(services);
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Dev native service startup and disposal failed");
		}
		throw error;
	}
}

export function disposeWebGuiServices(services: readonly WebGuiServiceDefinition[]): void {
	const failures: unknown[] = [];
	for (const service of services) {
		try {
			service.dispose();
		} catch (error) {
			logger.warn("WebGUI service disposal failed", { channel: service.name, error: String(error) });
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Dev native services did not settle");
}
