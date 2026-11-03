import { useEffect, useState } from "react";
import { statistics, type Statistics } from "./statistics";
export { statistics } from "./statistics";
/** Debounce and count off the input thread; never parse a megabyte per key. */
export function useStatistics(text: string): Statistics {
  const [value, setValue] = useState<Statistics>({ words: 0, characters: 0, minutes: 0 });
  useEffect(() => {
    let worker: Worker | undefined;
    const timer = window.setTimeout(() => {
      if (typeof Worker === "undefined") { setValue(statistics(text)); return; }
      worker = new Worker(new URL("./statistics-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<Statistics>) => setValue(event.data);
      worker.postMessage(text);
    }, 300);
    return () => { clearTimeout(timer); worker?.terminate(); };
  }, [text]);
  return value;
}
