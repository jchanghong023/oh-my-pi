import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import type { ModelProviderNavGroup, ModelProviderNavItem } from "./model-provider-section/constants.js";
import { InlineEditableProviderCard } from "./model-provider-section/InlineEditableProviderCard.js";
import { confirmAndDeleteModelProvider } from "./model-provider-section/modelProviderActions.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const [initialTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(() =>
    initialTarget ? createCustomProviderNodeKey(initialTarget.providerId) : null,
  );
  const [requestedProviderId, setRequestedProviderId] = useState<string | null>(
    initialTarget?.providerId ?? null,
  );
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const orderedProviders = useMemo(
    () => sortModelProvidersForDisplay(modelProviders, displayOrder),
    [modelProviders, displayOrder],
  );
  const navigationItems = useMemo<ModelProviderNavItem[]>(
    () => orderedProviders.map((provider) => ({
      key: createCustomProviderNodeKey(provider.providerId),
      type: "custom",
      label: getProviderFormLabel(provider),
      provider,
      statusActive: provider.executable === true,
    })),
    [orderedProviders],
  );
  const navigationGroups = useMemo<ModelProviderNavGroup[]>(
    () => [{
      id: "custom",
      title: intl.formatMessage({ id: "settings.modelProviderTitle" }),
      items: navigationItems,
    }],
    [intl, navigationItems],
  );
  const selectedProvider = orderedProviders.find(
    (provider) => createCustomProviderNodeKey(provider.providerId) === selectedNodeKey,
  );
  const navigationUnavailable = Boolean(
    requestedProviderId && !loading && !modelProviders.some(
      (provider) => provider.providerId === requestedProviderId,
    ),
  );

  const applyTarget = useCallback((target: SettingsModelProviderTarget | undefined) => {
    if (!target) return false;
    setRequestedProviderId(target.providerId);
    setSelectedNodeKey(createCustomProviderNodeKey(target.providerId));
    setTemplatePickerOpen(false);
    return true;
  }, []);

  useEffect(() => {
    if (applyTarget(pendingModelProviderTarget)) onConsumePendingModelProviderTarget?.();
  }, [applyTarget, pendingModelProviderTarget, onConsumePendingModelProviderTarget]);

  useEffect(() => addPendingSettingsSectionListener((section, detail) => {
    if (section === "modelProvider" && detail?.modelProviderId) {
      applyTarget({ providerId: detail.modelProviderId });
    }
  }), [applyTarget]);

  useEffect(() => {
    if (pendingCreatedProviderId) {
      if (!modelProviders.some((provider) => provider.providerId === pendingCreatedProviderId)) return;
      setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
      setRequestedProviderId(null);
      setPendingCreatedProviderId(null);
      return;
    }
    if (!requestedProviderId && !selectedProvider && orderedProviders.length > 0) {
      setSelectedNodeKey(createCustomProviderNodeKey(orderedProviders[0]!.providerId));
    }
  }, [pendingCreatedProviderId, modelProviders, requestedProviderId, selectedProvider, orderedProviders]);

  const handleCreateProvider = useCallback(async (input: { templateId?: string; providerName?: string }) => {
    setCreatingProvider(true);
    try {
      const created = await createPersonalProvider({ ...input, locale });
      setPendingCreatedProviderId(created.providerId);
      setRequestedProviderId(null);
      setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
      setTemplatePickerOpen(false);
    } finally {
      setCreatingProvider(false);
    }
  }, [createPersonalProvider, locale]);

  const handleReorderProviderIds = useCallback(async (orderedGroupProviderIds: string[]) => {
    const group = new Set(orderedGroupProviderIds);
    const currentIds = orderedProviders.map((provider) => provider.providerId);
    const insertionIndex = currentIds.findIndex((id) => group.has(id));
    if (insertionIndex < 0) return;
    const nextIds = currentIds.filter((id) => !group.has(id));
    nextIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
    await saveDisplayOrder({ providerIds: nextIds });
  }, [orderedProviders, saveDisplayOrder]);

  if (loadError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <Button type="button" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      customLoading={loading || refreshing}
      onRefresh={() => { void refresh(); }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      onSelectNavItem={(item) => {
        setRequestedProviderId(null);
        setSelectedNodeKey(item.key);
        setTemplatePickerOpen(false);
      }}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={reorderableProviderIds}
    >
      {navigationUnavailable && !templatePickerOpen && (
        <p role="alert" className="mb-3 text-ui-base text-destructive">
          {intl.formatMessage({ id: "settings.modelProvider.navigationUnavailable" })}
        </p>
      )}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => handleCreateProvider({ templateId })}
          onCreateCustom={(providerName) => handleCreateProvider({ providerName })}
        />
      ) : selectedProvider ? (
        <InlineEditableProviderCard
          key={selectedProvider.providerId}
          provider={selectedProvider}
          settingsRevision={providerSettingsView?.revision}
          onSave={saveProvider}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={
            selectedProvider.config.group === "zai-family" ||
            selectedProvider.config.group === "bigmodel-family"
              ? undefined
              : () => confirmAndDeleteModelProvider({
                  provider: selectedProvider, confirmDialog, intl, deleteProvider,
                })
          }
          onReorderModelIds={(ids) => reorderProviderModels(selectedProvider.providerId, ids)}
          onTestModel={testModelConnectivity}
        />
      ) : !loading && !navigationUnavailable ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.empty" })}
        </p>
      ) : null}
    </ModelProviderSectionLayout>
  );
}
