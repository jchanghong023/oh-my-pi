import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";

interface ProviderSetupScreenProps {
  onComplete: () => void | Promise<void>;
}

export function ProviderSetupScreen({ onComplete }: ProviderSetupScreenProps) {
  const { intl } = useZCodeIntl();
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = async () => {
    setCompleting(true);
    setError(null);
    try {
      await onComplete();
    } catch (error) {
      logger.error("[ProviderSetupScreen] Completing provider setup failed", error);
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompleting(false);
    }
  };

  return (
    <main className="flex h-full min-h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">
          {intl.formatMessage({ id: "settings.modelProviderTitle" })}
        </h1>
        <Button disabled={completing} onClick={() => void complete()}>
          {intl.formatMessage({ id: "common.confirm" })}
        </Button>
      </header>
      {error && (
        <Alert variant="destructive" className="mx-4 my-3 w-auto">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <ModelProviderSection />
      </div>
    </main>
  );
}
