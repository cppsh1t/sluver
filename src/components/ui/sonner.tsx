import { useEffect, useSyncExternalStore } from "react"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import { CheckmarkCircle02Icon, InformationCircleIcon, Alert02Icon, MultiplicationSignCircleIcon, Loading03Icon } from "@hugeicons/core-free-icons"

/** Reactively track whether the `.dark` class is present on `<html>`. */
function useIsDarkMode(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const observer = new MutationObserver(cb)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      })
      return () => observer.disconnect()
    },
    () => document.documentElement.classList.contains("dark"),
    () => false,
  )
}

const Toaster = ({ ...props }: ToasterProps) => {
  const isDark = useIsDarkMode()

  // Click-anywhere-on-toast-body dismissal. Buttons (action/cancel/close) handle themselves.
  // Element (not HTMLElement) so clicks landing on the SVG status icons dismiss too.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (!target.closest("[data-sonner-toast]")) return
      if (target.closest("[data-button]") || target.closest("[data-close-button]")) {
        return
      }
      toast.dismiss()
    }
    document.addEventListener("click", handleClick)
    return () => document.removeEventListener("click", handleClick)
  }, [])

  return (
    <Sonner
      theme={isDark ? "dark" : "light"}
      duration={2000}
      closeButton
      className="toaster group"
      icons={{
        success: (
          <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-4" />
        ),
        info: (
          <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="size-4" />
        ),
        warning: (
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" />
        ),
        error: (
          <HugeiconsIcon icon={MultiplicationSignCircleIcon} strokeWidth={2} className="size-4" />
        ),
        loading: (
          <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
