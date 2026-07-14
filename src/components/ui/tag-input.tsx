import * as React from "react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { cn } from "@/lib/utils"

interface TagInputProps
  extends Omit<React.ComponentProps<"div">, "onChange"> {
  value: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  disabled?: boolean
  maxTags?: number
}

function TagInput({
  value,
  onChange,
  placeholder,
  disabled,
  maxTags,
  className,
  ...props
}: TagInputProps) {
  const [inputValue, setInputValue] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement>(null)

  const isDuplicate = (tag: string) =>
    value.some((t) => t.toLowerCase() === tag.toLowerCase())

  const addTag = (text: string) => {
    const tag = text.trim()
    if (!tag || isDuplicate(tag) || (maxTags != null && value.length >= maxTags))
      return
    onChange([...value, tag])
  }

  const removeTag = (index: number) => {
    onChange(value.filter((_, i) => i !== index))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      addTag(inputValue)
      setInputValue("")
    } else if (
      e.key === "Backspace" &&
      inputValue === "" &&
      value.length > 0
    ) {
      removeTag(value.length - 1)
    }
  }

  const handleBlur = () => {
    if (inputValue.trim()) {
      addTag(inputValue)
      setInputValue("")
    }
  }

  const isFull = maxTags != null && value.length >= maxTags

  return (
    <div
      data-slot="tag-input"
      role="group"
      className={cn(
        "flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-input/20 px-2 py-0.5 text-sm transition-colors outline-none focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 md:text-xs/relaxed dark:bg-input/30",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
      onClick={() => inputRef.current?.focus()}
      {...props}
    >
      {value.map((tag, index) => (
        <span
          key={`${tag}-${index}`}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1.5 py-px text-xs text-muted-foreground"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              className="ml-0.5 inline-flex size-3.5 items-center justify-center rounded-sm text-muted-foreground/70 hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                removeTag(index)
              }}
              aria-label={`Remove ${tag}`}
            >
              <HugeiconsIcon icon={Cancel01Icon} />
            </button>
          )}
        </span>
      ))}
      {!isFull && (
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={value.length === 0 ? placeholder : undefined}
          disabled={disabled}
          className="min-w-16 flex-1 border-0 bg-transparent p-0 text-sm outline-none placeholder:text-muted-foreground md:text-xs/relaxed"
        />
      )}
    </div>
  )
}

export { TagInput }
