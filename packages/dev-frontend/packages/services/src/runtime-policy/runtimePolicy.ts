import type { DynamicWorkflowClientConfig, ZCodeModelContextBudgetStrategy } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IRuntimePolicyService {
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy>;
}

export const IRuntimePolicyService =
  createServiceDescriptor<IRuntimePolicyService>(ServiceChannels.RuntimePolicy);
