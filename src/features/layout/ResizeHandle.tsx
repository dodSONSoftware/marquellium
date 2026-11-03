import type { PointerEventHandler } from "react";

interface Props {
  className: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: "pixels" | "percent";
  onResize: (value: number) => void;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
}
export function ResizeHandle({ className, label, value, min, max, step, unit, onResize, onPointerDown }: Props) {
  return <div className={className} role="separator" tabIndex={0} aria-orientation="vertical" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${Math.round(value)} ${unit}`} onPointerDown={onPointerDown}
    onKeyDown={(event) => {
      const next = event.key === "ArrowLeft" ? value - step : event.key === "ArrowRight" ? value + step : event.key === "Home" ? min : event.key === "End" ? max : null;
      if (next === null) return;
      event.preventDefault(); onResize(Math.max(min, Math.min(max, next)));
    }} />;
}
