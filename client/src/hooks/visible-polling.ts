export const PUBLIC_VERIFICATION_REFRESH_INTERVAL_MS = 60_000;

type VisibilitySource = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * Poll at a fixed, low rate while the page is visible. Hidden tabs stop making
 * public reads and refresh immediately when they become visible again.
 */
export function startVisibilityAwarePolling(
  refresh: () => Promise<void>,
  source: VisibilitySource | undefined = typeof document === "undefined" ? undefined : document,
  intervalMs = PUBLIC_VERIFICATION_REFRESH_INTERVAL_MS,
): () => void {
  if (!source) return () => undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let refreshing = false;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    clearTimer();
    if (!stopped && !refreshing && source.visibilityState === "visible") {
      timer = setTimeout(() => {
        timer = undefined;
        void tick();
      }, intervalMs);
    }
  };

  const tick = async () => {
    if (stopped || source.visibilityState !== "visible" || refreshing) return;
    refreshing = true;
    try {
      await refresh();
    } finally {
      refreshing = false;
      schedule();
    }
  };

  const onVisibilityChange = () => {
    clearTimer();
    if (source.visibilityState === "visible") void tick();
  };

  source.addEventListener("visibilitychange", onVisibilityChange);
  schedule();

  return () => {
    stopped = true;
    clearTimer();
    source.removeEventListener("visibilitychange", onVisibilityChange);
  };
}