import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri, native, onFileOpenPending, onLifecycleRelease, type FileOpenRequest } from "../../services/native";
import { subscriptionScope } from "../../services/subscription-scope";

/** Native owns delivery until successful navigation or an explicit dismissal. */
export function useFileOpenRequests(ready: boolean, open: (path: string) => Promise<boolean>, report: (message: string) => void) {
  const callbacks = useRef({ ready, open, report });
  callbacks.current = { ready, open, report };
  const busy = useRef(false);
  const paused = useRef<FileOpenRequest | null>(null);
  const mounted = useRef(false);
  const [pending, setPending] = useState<FileOpenRequest | null>(null);
  const drain = useCallback(async () => {
    if (!isTauri() || busy.current || paused.current || !callbacks.current.ready || !mounted.current) return;
    busy.current = true;
    try {
      while (mounted.current && callbacks.current.ready) {
        const request = await native.fileOpen.next();
        if (!request || !mounted.current) break;
        if (request.error) callbacks.current.report(request.error);
        else if (request.path && !await callbacks.current.open(request.path)) {
          paused.current = request; setPending(request); break;
        }
        await native.fileOpen.ack(request.id);
      }
    } catch (error) { callbacks.current.report(`File opening failed: ${error}`); }
    finally { busy.current = false; }
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    mounted.current = true;
    const scope = subscriptionScope((error) => callbacks.current.report(String(error)));
    scope.add(onFileOpenPending(() => { void drain(); }));
    scope.add(onLifecycleRelease(() => { void drain(); }));
    void drain();
    return () => { mounted.current = false; scope.dispose(); };
  }, [drain]);
  useEffect(() => { if (ready) void drain(); }, [ready, drain]);
  const retry = () => { paused.current = null; setPending(null); void drain(); };
  const dismiss = async () => {
    if (!paused.current || busy.current) return;
    try { await native.fileOpen.ack(paused.current.id); paused.current = null; setPending(null); void drain(); }
    catch (error) { callbacks.current.report(String(error)); }
  };
  return { pending, retry, dismiss };
}
