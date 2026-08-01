import { useEffect, useState } from "react";

import { formatTime } from "@/lib/timemapper/format";

interface FormattedTimeProps {
  /** ISO 8601 timestamp to render in the current World's time representation. */
  iso: string;
  className?: string;
}

/**
 * Bridges the async `formatTime` API to synchronous JSX.
 *
 * Renders the raw `iso` immediately (no flash of empty), then swaps in the
 * World-formatted string once the mapper worker responds. On failure the
 * underlying API returns the raw ISO as the fallback `display`, so this
 * component never throws and never needs a loading state.
 *
 * Stale responses (from a previous `iso` after the prop changed, or any
 * response arriving after unmount) are ignored via a `stale` flag captured
 * per effect run.
 */
function FormattedTime({ iso, className }: FormattedTimeProps) {
  const [display, setDisplay] = useState(iso);

  useEffect(() => {
    // Optimistic: show the raw value while the worker computes the mapping.
    setDisplay(iso);

    let stale = false;
    formatTime(iso)
      .then((result) => {
        if (!stale) setDisplay(result.display);
      })
      // formatTime is documented as never throwing, but guard defensively
      // so a future regression cannot surface an unhandled rejection.
      .catch(() => {
        if (!stale) setDisplay(iso);
      });

    return () => {
      stale = true;
    };
  }, [iso]);

  return <span className={className}>{display}</span>;
}

export { FormattedTime };
