import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon } from "@hugeicons/core-free-icons"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface SearchablePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  searchPlaceholder: string
  searchValue: string
  onSearchChange: (value: string) => void
  /** Dialog max-width class. Default: "sm:max-w-2xl". Use "sm:max-w-4xl" for two-panel mode. */
  dialogClassName?: string
  /** "single" = search + grid stacked vertically. "two-panel" = grid left, sidePanel right. */
  mode?: "single" | "two-panel"
  /** Card grid content (the entity cards). Required. */
  children: React.ReactNode
  /** Right panel content (phase list, etc.). Only used when mode="two-panel". */
  sidePanel?: React.ReactNode
  /** Footer content (batch commit buttons, etc.). Optional. */
  footer?: React.ReactNode
  /** Show the built-in close button. Default: false (pickers manage their own close). */
  showCloseButton?: boolean
}

function SearchablePickerDialog({
  open,
  onOpenChange,
  title,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  dialogClassName,
  mode = "single",
  children,
  sidePanel,
  footer,
  showCloseButton,
}: SearchablePickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={showCloseButton ?? false}
        className={cn(
          "p-0 sm:max-w-2xl flex flex-col max-h-[85vh]",
          dialogClassName
        )}
      >
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="px-4 pb-2">
          <div className="relative">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={2}
              className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-9 pl-8"
            />
          </div>
        </div>

        {mode === "single" ? (
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
        ) : (
          <div className="flex flex-1 gap-2 overflow-hidden px-4">
            <div className="min-w-0 flex-1 overflow-y-auto p-1">{children}</div>
            {sidePanel ? (
              <div className="w-64 shrink-0 overflow-y-auto border-l pl-2">
                {sidePanel}
              </div>
            ) : null}
          </div>
        )}

        {footer ? (
          <DialogFooter className="border-t px-4 py-3">{footer}</DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export { SearchablePickerDialog }
export type { SearchablePickerDialogProps }
