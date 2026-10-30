/** Own subscriptions even when native registration finishes after cleanup. */
export function subscriptionScope(onError: (error: unknown) => void) {
  let disposed = false;
  const unlisteners: (() => void)[] = [];
  return {
    add(registration: Promise<() => void>): void {
      void registration.then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      }).catch((error: unknown) => {
        if (!disposed) onError(error);
      });
    },
    dispose(): void {
      disposed = true;
      for (const unlisten of unlisteners.splice(0)) unlisten();
    },
  };
}
