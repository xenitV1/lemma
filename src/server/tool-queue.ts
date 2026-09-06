// Include the entire request lifecycle, not only the handler: auto-session hooks
// must finish before a restore can discard the previous database state.
let tail: Promise<unknown> = Promise.resolve();

export function serializeToolCall<T>(operation: () => Promise<T>): Promise<T> {
  const result = tail.then(operation);
  tail = result.catch(() => undefined);
  return result;
}
