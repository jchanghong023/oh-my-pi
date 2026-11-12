import type { IServiceAccessor } from "@zcode/services";

/** A workspace attachment has its own endpoint identity while sharing its host's RPC wire.
 * Keep the base agent proxy out of the workspace registry, and never register one agent
 * proxy under multiple endpoint IDs. No services, business state or transports are created.
 */
export function createWorkspaceServiceProjection(services: IServiceAccessor): IServiceAccessor {
  const agent = new Proxy(services.zcodeAgentService, {});
  return new Proxy(services, {
    get(target, property, receiver) {
      return property === "zcodeAgentService" ? agent : Reflect.get(target, property, receiver);
    },
  });
}
