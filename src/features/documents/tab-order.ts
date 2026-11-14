interface OrderedTab { docId: string; pinned?: boolean }
export type CloseAction = "close" | "others" | "right" | "all";

export function closeTargets(tabs: readonly OrderedTab[], id: string, action: CloseAction): string[] {
  const index = tabs.findIndex((tab) => tab.docId === id);
  if (index < 0) return [];
  if (action === "close") return [id];
  return tabs.filter((tab, i) => !tab.pinned && (
    action === "all" || (action === "others" ? i !== index : i > index)
  )).map((tab) => tab.docId);
}

export function moveTab<T extends OrderedTab>(tabs: T[], id: string, targetId: string): T[] {
  const from = tabs.findIndex((tab) => tab.docId === id);
  const to = tabs.findIndex((tab) => tab.docId === targetId);
  const source = tabs[from], target = tabs[to];
  if (!source || !target || from === to || Boolean(source.pinned) !== Boolean(target.pinned)) return tabs;
  const next = [...tabs];
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}

export function toggleTabPin<T extends OrderedTab>(tabs: T[], id: string): T[] {
  const tab = tabs.find((item) => item.docId === id);
  if (!tab) return tabs;
  const rest = tabs.filter((item) => item !== tab);
  return [...rest.filter((item) => item.pinned), { ...tab, pinned: !tab.pinned }, ...rest.filter((item) => !item.pinned)];
}
