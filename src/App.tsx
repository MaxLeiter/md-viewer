import { useCallback } from "react";
import { useStore } from "./store";
import { TitleBar } from "./components/TitleBar";
import { Workspace } from "./components/Workspace";
import { SettingsPanel } from "./components/SettingsPanel";
import { RemotePrompt } from "./components/RemotePrompt";
import { AnnotationLayer } from "./components/AnnotationLayer";

export default function App() {
  const dropping = useStore((s) => s.dropping);
  const lightboxSrc = useStore((s) => s.lightboxSrc);
  const setLightbox = useStore((s) => s.setLightbox);

  // Close the lightbox with Escape while it's open.
  const attachLightbox = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") useStore.getState().setLightbox(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <Workspace />
      {dropping && (
        <div className="drop-overlay">
          <span>Drop files to open</span>
        </div>
      )}
      {lightboxSrc && (
        <div className="lightbox" ref={attachLightbox} onClick={() => setLightbox(null)}>
          <img src={lightboxSrc} alt="" />
        </div>
      )}
      <SettingsPanel />
      <RemotePrompt />
      <AnnotationLayer />
    </div>
  );
}
