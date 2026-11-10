import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";

export function resolveModelProviderDisplayName(provider: ProviderSettingsFormProvider): string {
  return getProviderFormLabel(provider);
}

export interface ModelProviderNavItem {
  key: string;
  type: "custom";
  label: string;
  provider: ProviderSettingsFormProvider;
  statusActive: boolean;
}

export interface ModelProviderNavGroup {
  id: "custom";
  title: string;
  items: ModelProviderNavItem[];
}
