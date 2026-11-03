// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
it("switching Files/TOC retains the workspace component and its chosen state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  function Files() { const [root, setRoot] = useState("none"); return <button onClick={() => setRoot("chosen workspace")}>{root}</button>; }
  function Demo() {
    const [section, setSection] = useState<"files" | "toc">("files");
    return <Sidebar outline={[]} tocActive width={240} onToggle={() => {}} onResize={() => {}} section={section} onSectionChange={setSection} files={<Files />} />;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
  try {
    await act(async () => root.render(<Demo />));
    await act(async () => button("none").click()); const fileButton = button("chosen workspace");
    await act(async () => button("TOC").click()); expect(fileButton.closest("[hidden]")).not.toBeNull();
    await act(async () => button("Files").click()); expect(button("chosen workspace")).toBe(fileButton); expect(fileButton.closest("[hidden]")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("keeps pointer resizing in logical sidebar units when the interface is scaled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.style.setProperty("--ui-scale", "2");
  const host = document.createElement("div"), root = createRoot(host), resize = vi.fn(); document.body.append(host);
  const pointer = (type: string, x: number) => new MouseEvent(type, { clientX: x, bubbles: true, cancelable: true });
  try {
    await act(async () => root.render(<Sidebar outline={[]} tocActive width={240} onToggle={() => {}} onResize={resize} />));
    await act(async () => host.querySelector('[role="separator"]')!.dispatchEvent(pointer("pointerdown", 480)));
    await act(async () => window.dispatchEvent(pointer("pointerup", 580)));
    expect(resize).toHaveBeenCalledExactlyOnceWith(290);
  } finally { await act(async () => root.unmount()); host.remove(); document.documentElement.style.removeProperty("--ui-scale"); vi.unstubAllGlobals(); }
});
