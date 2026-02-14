import { useState, useCallback, useRef } from "react";

/**
 * Shared hook for toast notification state.
 * Returns { message, show } where `show(msg)` displays a toast
 * that auto-dismisses after `duration` ms.
 */
export function useToast(duration = 2000) {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback(
    (msg: string) => {
      // Clear any existing timer so rapid calls reset the clock
      if (timerRef.current) clearTimeout(timerRef.current);
      setMessage(msg);
      timerRef.current = setTimeout(() => setMessage(null), duration);
    },
    [duration]
  );

  return { message, show };
}
