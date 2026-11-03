import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../services/native";
/** Opt-in native release profiling. Only --m5-benchmark permits reporting/exiting. */
export function useBenchmark(text: string, rendered: string, view: React.RefObject<EditorView | null>, flush: () => Promise<unknown>) {
  const [enabled, setEnabled] = useState(false), started = useRef(false);
  useEffect(() => { if (isTauri()) void invoke<number | null>("benchmark_clock").then((v) => setEnabled(v !== null)); }, []);
  useEffect(() => {
    if (!enabled || started.current || text.length < 1_000_000 || text !== rendered || !view.current) return;
    started.current = true;
    void (async () => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await frame(); await frame();
      const openMs = await invoke<number>("benchmark_ready");
      const samples: number[] = [];
      for (let i = 0; i < 100; i++) {
        await frame();
        const editor = view.current!;
        const start = performance.now();
        editor.dispatch({ changes: { from: editor.state.doc.length, insert: "x" } });
        samples.push(performance.now() - start);
      }
      await flush(); await frame();
      await invoke("benchmark_report", { result: { openMs, inputMs: samples, bytes: new TextEncoder().encode(text).length, userAgent: navigator.userAgent } });
    })().catch((error) => { void invoke("benchmark_report", { result: { error: String(error) } }); });
  }, [enabled, text, rendered, view, flush]);
}
