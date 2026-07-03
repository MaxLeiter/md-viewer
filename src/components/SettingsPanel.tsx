import { useCallback, useState } from "react";
import {
  applySettings,
  captureKeybind,
  formatKeybind,
  KEYBINDS,
  keybindFor,
  suspendMenuAccelerators,
  useSettings,
} from "../settings";
import type { KeybindDef, Settings, ThemeSetting, WidthSetting } from "../settings";
import type { ViewMode } from "../types";
import { CloseIcon, ResetIcon } from "./icons";

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-segmented">
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function KeybindRow({
  def,
  settings,
  recording,
  onRecord,
}: {
  def: KeybindDef;
  settings: Settings;
  recording: boolean;
  onRecord: (id: string | null) => void;
}) {
  const setKeybind = useSettings((s) => s.setKeybind);
  const current = keybindFor(settings, def.id);
  const customized = current !== def.defaultKey;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      onRecord(null);
      applySettings(useSettings.getState().settings); // restore menu accelerators
      return;
    }
    const captured = captureKeybind(event.nativeEvent, def.kind);
    if (!captured) return;
    setKeybind(def.id, captured);
    onRecord(null);
  };

  return (
    <div className="settings-keybind-row">
      <span className="settings-keybind-label">{def.label}</span>
      <button
        className={`settings-keybind-chip${recording ? " recording" : ""}${customized ? " customized" : ""}`}
        onClick={() => {
          if (recording) return;
          suspendMenuAccelerators();
          onRecord(def.id);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (recording) {
            onRecord(null);
            applySettings(useSettings.getState().settings);
          }
        }}
      >
        {recording ? "Press keys…" : formatKeybind(current)}
      </button>
      <button
        className="settings-keybind-reset"
        data-tip="Reset to default"
        disabled={!customized}
        onClick={() => setKeybind(def.id, null)}
      >
        <ResetIcon size={13} />
      </button>
    </div>
  );
}

export function SettingsPanel() {
  const open = useSettings((s) => s.open);
  const setOpen = useSettings((s) => s.setOpen);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const resetKeybinds = useSettings((s) => s.resetKeybinds);
  const [recordingId, setRecordingId] = useState<string | null>(null);

  // Esc closes the panel (when not capturing a shortcut).
  const attachPanel = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const state = useSettings.getState();
      if (state.open) state.setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;

  const editorBinds = KEYBINDS.filter((k) => k.kind === "editor");
  const menuBinds = KEYBINDS.filter((k) => k.kind === "menu");

  return (
    <div className="settings-backdrop" onClick={() => setOpen(false)}>
      <div
        className="settings-panel"
        ref={attachPanel}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={() => setOpen(false)}>
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="settings-body">
          <section>
            <h3>Appearance</h3>
            <div className="settings-row">
              <span>Theme</span>
              <Segmented<ThemeSetting>
                value={settings.theme}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
                onChange={(theme) => update({ theme })}
              />
            </div>
            <div className="settings-row">
              <span>Content width</span>
              <Segmented<WidthSetting>
                value={settings.editorWidth}
                options={[
                  { value: "narrow", label: "Narrow" },
                  { value: "normal", label: "Normal" },
                  { value: "wide", label: "Wide" },
                  { value: "full", label: "Full" },
                ]}
                onChange={(editorWidth) => update({ editorWidth })}
              />
            </div>
            <div className="settings-row">
              <span>Animated caret</span>
              <Segmented<"on" | "off">
                value={settings.caretAnimation ? "on" : "off"}
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
                onChange={(value) => update({ caretAnimation: value === "on" })}
              />
            </div>
            <div className="settings-row">
              <span>Open files in</span>
              <Segmented<ViewMode>
                value={settings.defaultMode}
                options={[
                  { value: "editor", label: "Editor" },
                  { value: "split", label: "Split" },
                  { value: "preview", label: "Preview" },
                ]}
                onChange={(defaultMode) => update({ defaultMode })}
              />
            </div>
            <div className="settings-row">
              <span>Format on save</span>
              <Segmented<"on" | "off">
                value={settings.formatOnSave ? "on" : "off"}
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
                onChange={(value) => update({ formatOnSave: value === "on" })}
              />
            </div>
          </section>

          <section>
            <h3>Remote (SSH)</h3>
            <div className="settings-row">
              <span>Default host</span>
              <input
                className="settings-input"
                placeholder="e.g. coder.box"
                value={settings.defaultRemoteHost}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => update({ defaultRemoteHost: event.target.value.trim() })}
              />
            </div>
            <p className="settings-note">
              Used when an <code>mdviewer://</code> link or <code>mdv</code> command omits a
              host. Files open over your system SSH (honors <code>~/.ssh/config</code>).
            </p>
          </section>

          <section>
            <div className="settings-section-header">
              <h3>Keyboard — Editor</h3>
              <button className="settings-text-btn" onClick={resetKeybinds}>
                Reset all
              </button>
            </div>
            {editorBinds.map((def) => (
              <KeybindRow
                key={def.id}
                def={def}
                settings={settings}
                recording={recordingId === def.id}
                onRecord={setRecordingId}
              />
            ))}
          </section>

          <section>
            <h3>Keyboard — Application</h3>
            {menuBinds.map((def) => (
              <KeybindRow
                key={def.id}
                def={def}
                settings={settings}
                recording={recordingId === def.id}
                onRecord={setRecordingId}
              />
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
