import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { LockKeyIcon } from "@hugeicons/core-free-icons";

import { useOpenSpace } from "@/hooks";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import type { SpaceId } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface SpacePasswordGateProps {
  spaceId: SpaceId;
  spaceName: string;
}

/**
 * In-page overlay that obscures a password-protected Space's content while
 * the Space is in its *locked* state (per ADR-0008 + CONTEXT.md).
 *
 * The Space tab stays open in the TitleBar; this gate covers only the
 * Space's content area (absolute inset-0 within a relative-positioned
 * parent). The parent renders it when the session reports the Space as
 * locked and stops rendering it once {@link useOpenSpace} succeeds — the
 * hook updates the `['session']` cache via `setQueryData`, the parent
 * re-renders, and this component unmounts.
 *
 * This is deliberately NOT a pre-entry screen, NOT a dismissable modal,
 * and NOT `aria-modal`: the TitleBar tabs must remain focusable/clickable
 * so the user can switch Spaces even while one is locked. The only way
 * past the gate is the correct password or closing the tab.
 */
export function SpacePasswordGate({
  spaceId,
  spaceName,
}: SpacePasswordGateProps) {
  const { t } = useTranslation(["space", "common"]);
  const openSpace = useOpenSpace();
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password || openSpace.isPending) return;
    setSubmitError(null);
    try {
      await openSpace.mutateAsync({ id: spaceId, password });
      // Success: the hook updates the session cache (setQueryData(['session'])),
      // the parent re-renders and unmounts this gate. Clear local state
      // defensively in case unmount is deferred by a render cycle.
      setPassword("");
    } catch (err) {
      // translateError routes through the global i18n instance (see
      // AGENTS.md §Error translation pipeline), so it is safe inside this
      // async callback — the hook `t` would trip exhaustive-deps here.
      // SPACE_WRONG_PASSWORD resolves to the localized "wrong password".
      setSubmitError(translateError(toErrorPayload(err)));
    }
  }

  const pending = openSpace.isPending;
  const invalid = submitError !== null;

  return (
    <div
      aria-label={t("space:gate.title")}
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/85 p-6 backdrop-blur-md"
    >
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader>
          <div
            aria-hidden
            className="mb-1 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
          >
            <HugeiconsIcon
              icon={LockKeyIcon}
              className="size-5"
              strokeWidth={2}
            />
          </div>
          <CardTitle className="text-base">{t("space:gate.title")}</CardTitle>
          <CardDescription>
            {t("space:gate.subtitle", { name: spaceName })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} autoComplete="off">
            <FieldGroup>
              <Field data-invalid={invalid ? true : undefined}>
                <FieldLabel htmlFor="space-password">
                  {t("space:gate.passwordLabel")}
                </FieldLabel>
                <Input
                  id="space-password"
                  type="password"
                  autoComplete="current-password"
                  spellCheck={false}
                  placeholder={t("space:gate.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  aria-invalid={invalid ? true : undefined}
                  autoFocus
                  data-testid="gate-password-input"
                />
                {submitError && <FieldError>{submitError}</FieldError>}
              </Field>
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={!password || pending}
                data-testid="gate-unlock-button"
              >
                {pending ? t("space:gate.unlocking") : t("space:gate.unlock")}
              </Button>
            </FieldGroup>
          </form>
          <p className="mt-3 text-center text-xs/relaxed text-muted-foreground">
            {t("space:gate.hint")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
