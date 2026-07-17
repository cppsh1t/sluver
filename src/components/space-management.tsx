import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import {
  useCreateSpace,
  useDeleteSpace,
  useSetSpacePassword,
} from "@/hooks";
import type { SpaceSummary } from "@/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Stable error codes emitted by the Rust backend (see db/error.rs `to_payload`).
// Matched against ErrorPayload.code so business errors surface as field-level
// inline messages instead of a generic toast.
const SPACE_NAME_TAKEN = "SPACE_NAME_TAKEN";
const SPACE_WRONG_PASSWORD = "SPACE_WRONG_PASSWORD";

type PasswordMode = "change" | "remove";

// ─────────────────────────────────────────────────────────────────────────────
// CreateSpaceDialog
// ─────────────────────────────────────────────────────────────────────────────

interface CreateSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Create a new Space with an optional password. The password gate is opt-in
 * via a Switch; when enabled, a new-password + confirm pair is validated
 * client-side (mismatch) before the IPC call. `SPACE_NAME_TAKEN` is surfaced
 * as an inline error on the name field.
 */
function CreateSpaceDialog({ open, onOpenChange }: CreateSpaceDialogProps) {
  const { t } = useTranslation(["space", "common"]);
  const createMut = useCreateSpace();

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);

  // Clear sensitive + transient state whenever the dialog closes — covers both
  // UI-initiated close (X / backdrop / escape) and parent-driven `open=false`.
  useEffect(() => {
    if (!open) {
      setName("");
      setNameError(null);
      setPasswordEnabled(false);
      setPassword("");
      setConfirm("");
      setPwError(null);
    }
  }, [open]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createMut.isPending) return;

    if (passwordEnabled) {
      const mismatch =
        password !== confirm
          ? t("space:management.password.mismatch")
          : null;
      setPwError(mismatch);
      if (mismatch) return;
    }

    try {
      await createMut.mutateAsync({
        name: trimmed,
        password: passwordEnabled ? password : undefined,
      });
      toast.success(i18n.t("space:toast.createSuccess"));
      onOpenChange(false);
    } catch (err) {
      const payload = toErrorPayload(err);
      if (payload.code === SPACE_NAME_TAKEN) {
        setNameError(i18n.t("space:errors.nameTaken"));
      } else {
        toast.error(i18n.t("space:toast.createFailed"), {
          description: translateError(payload),
        });
      }
    }
  }

  const submitDisabled =
    !name.trim() ||
    createMut.isPending ||
    (passwordEnabled && !password.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("space:management.create.title")}</DialogTitle>
          <DialogDescription>
            {t("space:management.create.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field data-invalid={!!nameError || undefined}>
              <FieldLabel htmlFor="create-space-name">
                {t("space:management.create.nameLabel")}
              </FieldLabel>
              <Input
                id="create-space-name"
                data-testid="create-space-name"
                value={name}
                onChange={(e) => {
                  setName(e.currentTarget.value);
                  setNameError(null);
                }}
                placeholder={t("space:management.create.namePlaceholder")}
                autoFocus
                aria-invalid={!!nameError}
              />
              {nameError && <FieldError>{nameError}</FieldError>}
            </Field>

            <Field orientation="horizontal">
              <Switch
                id="create-space-set-password"
                data-testid="create-space-set-password"
                checked={passwordEnabled}
                onCheckedChange={(checked) => {
                  setPasswordEnabled(checked);
                  setPwError(null);
                }}
              />
              <FieldLabel htmlFor="create-space-set-password">
                {t("space:management.create.setPassword")}
              </FieldLabel>
            </Field>

            {passwordEnabled && (
              <>
                <Field>
                  <FieldLabel htmlFor="create-space-password">
                    {t("space:management.create.passwordLabel")}
                  </FieldLabel>
                  <Input
                    id="create-space-password"
                    data-testid="create-space-password"
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.currentTarget.value);
                      setPwError(null);
                    }}
                    placeholder={t("space:management.create.passwordPlaceholder")}
                  />
                  <FieldDescription>
                    {t("space:management.create.passwordHint")}
                  </FieldDescription>
                </Field>
                <Field data-invalid={!!pwError || undefined}>
                  <FieldLabel htmlFor="create-space-pw-confirm">
                    {t("space:management.password.newConfirmLabel")}
                  </FieldLabel>
                  <Input
                    id="create-space-pw-confirm"
                    type="password"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.currentTarget.value);
                      setPwError(null);
                    }}
                    placeholder={t(
                      "space:management.password.newConfirmPlaceholder",
                    )}
                    aria-invalid={!!pwError}
                  />
                  {pwError && <FieldError>{pwError}</FieldError>}
                </Field>
              </>
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common:actions.cancel")}
            </DialogClose>
            <Button
              type="submit"
              data-testid="create-space-submit"
              disabled={submitDisabled}
            >
              {createMut.isPending
                ? t("space:management.create.submitting")
                : t("space:management.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DeleteSpaceDialog
// ─────────────────────────────────────────────────────────────────────────────

interface DeleteSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Space being deleted; its `hasPassword` flag drives the password gate. */
  space: SpaceSummary;
}

/**
 * Permanently delete a Space. The body discloses the cascade (all Worlds +
 * their content). Protected Spaces require the password to be re-entered; the
 * submit button stays disabled until it is, and `SPACE_WRONG_PASSWORD` is
 * surfaced inline on the password field.
 */
function DeleteSpaceDialog({
  open,
  onOpenChange,
  space,
}: DeleteSpaceDialogProps) {
  const { t } = useTranslation(["space", "common"]);
  const deleteMut = useDeleteSpace();

  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setPwError(null);
    }
  }, [open]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (deleteMut.isPending) return;

    try {
      await deleteMut.mutateAsync({
        id: space.id,
        password: space.hasPassword ? password : undefined,
      });
      toast.success(i18n.t("space:toast.deleteSuccess"));
      onOpenChange(false);
    } catch (err) {
      const payload = toErrorPayload(err);
      if (payload.code === SPACE_WRONG_PASSWORD) {
        setPwError(i18n.t("space:errors.wrongPassword"));
      } else {
        toast.error(i18n.t("space:toast.deleteFailed"), {
          description: translateError(payload),
        });
      }
    }
  }

  const submitDisabled =
    deleteMut.isPending || (space.hasPassword && !password);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="delete-space-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("space:management.delete.title", { name: space.name })}
          </DialogTitle>
          <DialogDescription>
            {t("space:management.delete.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          {space.hasPassword && (
            <FieldGroup>
              <FieldDescription>
                {t("space:management.delete.passwordRequired")}
              </FieldDescription>
              <Field data-invalid={!!pwError || undefined}>
                <FieldLabel htmlFor="delete-space-password">
                  {t("space:management.delete.passwordLabel")}
                </FieldLabel>
                <Input
                  id="delete-space-password"
                  data-testid="delete-space-password"
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.currentTarget.value);
                    setPwError(null);
                  }}
                  placeholder={t("space:management.delete.passwordPlaceholder")}
                  autoFocus
                  aria-invalid={!!pwError}
                />
                {pwError && <FieldError>{pwError}</FieldError>}
              </Field>
            </FieldGroup>
          )}
          <DialogFooter className="mt-4">
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common:actions.cancel")}
            </DialogClose>
            <Button
              type="submit"
              variant="destructive"
              data-testid="delete-space-submit"
              disabled={submitDisabled}
            >
              {deleteMut.isPending
                ? t("space:management.delete.submitting")
                : t("space:management.delete.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SpacePasswordDialog — add / change / remove
// ─────────────────────────────────────────────────────────────────────────────

interface SpacePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Space whose password is being managed. */
  space: SpaceSummary;
}

/**
 * Manages a Space's password lifecycle. Adapts to the Space's current state:
 *
 * - `!space.hasPassword` → **add** mode: a single new-password + confirm pair.
 *   Submits `{ newPassword }` (no current password needed).
 * - `space.hasPassword` → a **change / remove** tab toggle:
 *   - change → `{ currentPassword, newPassword }` (+ confirm, mismatch-checked).
 *   - remove → `{ currentPassword, newPassword: undefined }`.
 *
 * The current password is verified server-side (argon2id); a wrong value is
 * surfaced inline via `SPACE_WRONG_PASSWORD`.
 */
function SpacePasswordDialog({
  open,
  onOpenChange,
  space,
}: SpacePasswordDialogProps) {
  const { t } = useTranslation(["space", "common"]);
  const passwordMut = useSetSpacePassword();

  // `mode` only applies to the change/remove tab view (protected Spaces).
  const [mode, setMode] = useState<PasswordMode>("change");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setMode("change");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setCurrentError(null);
      setNewError(null);
    }
  }, [open]);

  function handleError(err: unknown, source: "add" | "change" | "remove") {
    const payload = toErrorPayload(err);
    if (payload.code === SPACE_WRONG_PASSWORD) {
      setCurrentError(i18n.t("space:errors.wrongPassword"));
    } else {
      toast.error(
        i18n.t(
          source === "remove"
            ? "space:toast.passwordRemoveFailed"
            : "space:toast.passwordSetFailed",
        ),
        { description: translateError(payload) },
      );
    }
  }

  // ── add (unprotected Space) ──────────────────────────────────────────────
  async function submitAdd(e: FormEvent) {
    e.preventDefault();
    if (passwordMut.isPending) return;
    const mismatch =
      newPw !== confirmPw ? t("space:management.password.mismatch") : null;
    setNewError(mismatch);
    if (mismatch) return;

    try {
      await passwordMut.mutateAsync({
        id: space.id,
        input: { newPassword: newPw },
      });
      toast.success(i18n.t("space:toast.passwordSetSuccess"));
      onOpenChange(false);
    } catch (err) {
      handleError(err, "add");
    }
  }

  // ── change (protected Space) ─────────────────────────────────────────────
  async function submitChange(e: FormEvent) {
    e.preventDefault();
    if (passwordMut.isPending || !currentPw.trim() || !newPw.trim()) return;
    const mismatch =
      newPw !== confirmPw ? t("space:management.password.mismatch") : null;
    setNewError(mismatch);
    if (mismatch) return;

    try {
      await passwordMut.mutateAsync({
        id: space.id,
        input: { currentPassword: currentPw, newPassword: newPw },
      });
      toast.success(i18n.t("space:toast.passwordSetSuccess"));
      onOpenChange(false);
    } catch (err) {
      handleError(err, "change");
    }
  }

  // ── remove (protected Space) ─────────────────────────────────────────────
  async function submitRemove(e: FormEvent) {
    e.preventDefault();
    if (passwordMut.isPending || !currentPw.trim()) return;

    try {
      await passwordMut.mutateAsync({
        id: space.id,
        input: { currentPassword: currentPw, newPassword: undefined },
      });
      toast.success(i18n.t("space:toast.passwordRemoveSuccess"));
      onOpenChange(false);
    } catch (err) {
      handleError(err, "remove");
    }
  }

  // ── ADD branch (no current password to verify) ───────────────────────────
  if (!space.hasPassword) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("space:management.password.titleAdd")}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submitAdd}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="space-pw-new">
                  {t("space:management.password.newLabel")}
                </FieldLabel>
                <Input
                  id="space-pw-new"
                  type="password"
                  value={newPw}
                  onChange={(e) => {
                    setNewPw(e.currentTarget.value);
                    setNewError(null);
                  }}
                  placeholder={t("space:management.password.newPlaceholder")}
                  autoFocus
                />
              </Field>
              <Field data-invalid={!!newError || undefined}>
                <FieldLabel htmlFor="space-pw-confirm">
                  {t("space:management.password.newConfirmLabel")}
                </FieldLabel>
                <Input
                  id="space-pw-confirm"
                  type="password"
                  value={confirmPw}
                  onChange={(e) => {
                    setConfirmPw(e.currentTarget.value);
                    setNewError(null);
                  }}
                  placeholder={t(
                    "space:management.password.newConfirmPlaceholder",
                  )}
                  aria-invalid={!!newError}
                />
                {newError && <FieldError>{newError}</FieldError>}
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-4">
              <DialogClose render={<Button variant="outline" type="button" />}>
                {t("common:actions.cancel")}
              </DialogClose>
              <Button
                type="submit"
                disabled={passwordMut.isPending || !newPw.trim()}
              >
                {passwordMut.isPending
                  ? t("space:management.password.submitting")
                  : t("space:management.password.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  // ── CHANGE + REMOVE branch (protected Space) ─────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "change"
              ? t("space:management.password.titleChange")
              : t("space:management.password.titleRemove")}
          </DialogTitle>
        </DialogHeader>

        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as PasswordMode)}
        >
          <TabsList>
            <TabsTrigger value="change">
              {t("space:management.password.titleChange")}
            </TabsTrigger>
            <TabsTrigger value="remove">
              {t("space:management.password.titleRemove")}
            </TabsTrigger>
          </TabsList>

          {/* CHANGE */}
          <TabsContent value="change">
            <form onSubmit={submitChange}>
              <FieldGroup>
                <Field data-invalid={!!currentError || undefined}>
                  <FieldLabel htmlFor="space-pw-current-change">
                    {t("space:management.password.currentLabel")}
                  </FieldLabel>
                  <Input
                    id="space-pw-current-change"
                    type="password"
                    value={currentPw}
                    onChange={(e) => {
                      setCurrentPw(e.currentTarget.value);
                      setCurrentError(null);
                    }}
                    placeholder={t(
                      "space:management.password.currentPlaceholder",
                    )}
                    aria-invalid={!!currentError}
                  />
                  {currentError && <FieldError>{currentError}</FieldError>}
                </Field>
                <Field>
                  <FieldLabel htmlFor="space-pw-new-change">
                    {t("space:management.password.newLabel")}
                  </FieldLabel>
                  <Input
                    id="space-pw-new-change"
                    type="password"
                    value={newPw}
                    onChange={(e) => {
                      setNewPw(e.currentTarget.value);
                      setNewError(null);
                    }}
                    placeholder={t("space:management.password.newPlaceholder")}
                  />
                </Field>
                <Field data-invalid={!!newError || undefined}>
                  <FieldLabel htmlFor="space-pw-confirm-change">
                    {t("space:management.password.newConfirmLabel")}
                  </FieldLabel>
                  <Input
                    id="space-pw-confirm-change"
                    type="password"
                    value={confirmPw}
                    onChange={(e) => {
                      setConfirmPw(e.currentTarget.value);
                      setNewError(null);
                    }}
                    placeholder={t(
                      "space:management.password.newConfirmPlaceholder",
                    )}
                    aria-invalid={!!newError}
                  />
                  {newError && <FieldError>{newError}</FieldError>}
                </Field>
              </FieldGroup>
              <DialogFooter className="mt-4">
                <DialogClose render={<Button variant="outline" type="button" />}>
                  {t("common:actions.cancel")}
                </DialogClose>
                <Button
                  type="submit"
                  disabled={
                    passwordMut.isPending ||
                    !currentPw.trim() ||
                    !newPw.trim()
                  }
                >
                  {passwordMut.isPending
                    ? t("space:management.password.submitting")
                    : t("space:management.password.submit")}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>

          {/* REMOVE */}
          <TabsContent value="remove">
            <form onSubmit={submitRemove}>
              <FieldGroup>
                <FieldDescription>
                  {t("space:management.password.removeConfirm")}
                </FieldDescription>
                <Field data-invalid={!!currentError || undefined}>
                  <FieldLabel htmlFor="space-pw-current-remove">
                    {t("space:management.password.currentLabel")}
                  </FieldLabel>
                  <Input
                    id="space-pw-current-remove"
                    type="password"
                    value={currentPw}
                    onChange={(e) => {
                      setCurrentPw(e.currentTarget.value);
                      setCurrentError(null);
                    }}
                    placeholder={t(
                      "space:management.password.currentPlaceholder",
                    )}
                    aria-invalid={!!currentError}
                    autoFocus
                  />
                  {currentError && <FieldError>{currentError}</FieldError>}
                </Field>
              </FieldGroup>
              <DialogFooter className="mt-4">
                <DialogClose render={<Button variant="outline" type="button" />}>
                  {t("common:actions.cancel")}
                </DialogClose>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={passwordMut.isPending || !currentPw.trim()}
                >
                  {passwordMut.isPending
                    ? t("space:management.password.submitting")
                    : t("space:management.password.submit")}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export { CreateSpaceDialog, DeleteSpaceDialog, SpacePasswordDialog };
