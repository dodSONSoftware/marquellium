export function normalizeDisplayScale(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value === 0 ? 100 : Math.max(75, Math.min(200, Math.round(value)));
}

/** Scale chrome and document surfaces independently; never zoom the entire webview. */
export function applyDisplayScales(uiScale: number | undefined, documentScale: number | undefined): void {
  const style = document.documentElement.style;
  style.setProperty("--ui-scale", String(normalizeDisplayScale(uiScale) / 100));
  style.setProperty("--document-scale", String(normalizeDisplayScale(documentScale) / 100));
}
