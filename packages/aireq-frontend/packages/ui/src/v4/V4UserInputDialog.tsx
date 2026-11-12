import { useCallback, useRef, useState } from "react";
import {
  TID_V4_USER_INPUT_DIALOG,
  TID_V4_USER_INPUT_OPTION,
  TID_V4_USER_INPUT_TEXT,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import type { V4UserInputViewModel } from "@/v4/pendingInteractionAdapter.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface V4UserInputDialogProps {
  model: V4UserInputViewModel;
  errorMessage?: string;
  onSubmit: (answer: { optionId?: string; freeText?: string; action?: "cancel" }) => Promise<boolean>;
}

/** Native user-input questions retain their answer until authoritative acceptance. */
export function V4UserInputDialog({ model, onSubmit, errorMessage }: V4UserInputDialogProps) {
  const [freeText, setFreeText] = useState(model.prefill ?? "");
  const { intl } = useZCodeIntl();
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitAnswer = useCallback(async (answer: { optionId?: string; freeText?: string; action?: "cancel" }) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailed(false);
    let accepted = false;
    try {
      accepted = await onSubmit(answer);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      submittingRef.current = false;
      setSubmitting(false);
      setFailed(true);
    }
  }, [onSubmit]);

  const handleOption = useCallback(
    (optionId: string) => {
      void submitAnswer({ optionId });
    },
    [submitAnswer],
  );

  const handleFreeTextSubmit = useCallback(() => {
    const trimmed = model.preserveWhitespace ? freeText : freeText.trim();
    if (!trimmed && model.freeText && !model.allowEmpty) return;
    void submitAnswer(model.freeText ? { freeText: trimmed } : { optionId: model.options[0]?.optionId });
  }, [freeText, model.freeText, model.options, model.allowEmpty, model.preserveWhitespace, submitAnswer]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      data-testid={TID_V4_USER_INPUT_DIALOG}
      data-interaction-id={model.interactionId}
      aria-busy={submitting}
    >
      <div className="w-full max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-lg">
        <p className="mb-3 text-ui-base text-[var(--color-foreground)]">{model.prompt}</p>
        {model.options.length > 0 ? (
          <div className="mb-3 flex flex-col gap-2">
            {model.options.map((option) => (
              <Button
                key={option.optionId}
                type="button"
                variant="outline"
                data-testid={testId(TID_V4_USER_INPUT_OPTION, option.optionId)}
                disabled={submitting}
                onClick={() => handleOption(option.optionId)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : null}
        {model.freeText ? (
          <div className="flex flex-col gap-2">
            {model.multiline && !model.sensitive ? (
              <textarea
                className="min-h-48 w-full rounded-md border border-input bg-transparent px-3 py-2 text-ui-base"
                value={freeText}
                disabled={submitting}
                placeholder={model.placeholder}
                onChange={(event) => setFreeText(event.target.value)}
                data-testid={TID_V4_USER_INPUT_TEXT}
              />
            ) : (
            <Input
              type={model.sensitive ? "password" : "text"}
              value={freeText}
              disabled={submitting}
              placeholder={model.placeholder}
              onChange={(event) => setFreeText(event.target.value)}
              data-testid={TID_V4_USER_INPUT_TEXT}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  handleFreeTextSubmit();
                }
              }}
            />
            )}
            <Button type="button" disabled={submitting || (!model.allowEmpty && !freeText.trim())} data-testid="v4-user-input-submit" onClick={handleFreeTextSubmit}>
              提交
            </Button>
          </div>
        ) : null}
        <Button type="button" variant="outline" disabled={submitting}
          data-testid="v4-user-input-cancel" onClick={() => void submitAnswer({ action: "cancel" })}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        {failed ? (
          <p role="alert" className="mt-2 text-ui-sm text-destructive">
            {errorMessage ?? intl.formatMessage({ id: "chat.permission.responseFailed" })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
