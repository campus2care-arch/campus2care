/** Node turns a negative AbortSignal.timeout into a 1ms timer and emits TimeoutNegativeWarning. */
export function boundedAbortSignal(milliseconds: number): AbortSignal {
  const ms = Number.isFinite(milliseconds) ? Math.floor(milliseconds) : 0;
  if (ms <= 0) {
    const controller = new AbortController();
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    return controller.signal;
  }
  return AbortSignal.timeout(Math.min(ms, 2_147_483_647));
}
