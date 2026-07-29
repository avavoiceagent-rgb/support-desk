import { useEffect, useRef } from "react";

/**
 * Calls `callback` immediately and then every `intervalMs`, pausing while the
 * tab is hidden. Small-team scale means simple polling beats the complexity
 * of websockets here.
 */
export function usePolling(callback: () => void, intervalMs: number) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") callbackRef.current();
    };
    tick();
    const id = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs]);
}
