import { PrintPreview } from "./features/export/PrintPreview";
import { PrototypeApp } from "./features/visual/PrototypeApp";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import "./styles/global.css";

const prototypeDoc = import.meta.env.VITE_M3V_VISUAL_PROTOTYPE === "1" ? new URL(location.href).searchParams.get("m3vDocument") : null;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  new URL(location.href).searchParams.has("exportPreview") ? <PrintPreview /> : prototypeDoc ? <PrototypeApp docId={prototypeDoc} /> : <React.StrictMode>
    <App />
  </React.StrictMode>,
);
