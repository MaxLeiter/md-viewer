import { useCallback, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings";

/** "Open Remote…" — type `host:/path` (or `:/path` to use the default host). */
export function RemotePrompt() {
  const open = useStore((s) => s.remotePromptOpen);
  const setRemotePrompt = useStore((s) => s.setRemotePrompt);
  const defaultHost = useSettings((s) => s.settings.defaultRemoteHost);
  const [value, setValue] = useState("");

  const attach = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    input.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") useStore.getState().setRemotePrompt(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;

  const submit = () => {
    const spec = value.trim();
    setRemotePrompt(false);
    setValue("");
    if (spec) void useStore.getState().openPaths([spec]);
  };

  const placeholder = defaultHost ? `${defaultHost}:/path/to/file.md` : "host:/path/to/file.md";

  return (
    <div className="settings-backdrop" onClick={() => setRemotePrompt(false)}>
      <div className="remote-prompt" onClick={(event) => event.stopPropagation()}>
        <label className="remote-prompt-label" htmlFor="remote-spec">
          Open remote file
        </label>
        <input
          id="remote-spec"
          ref={attach}
          className="remote-prompt-input"
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <p className="remote-prompt-hint">
          {defaultHost ? (
            <>
              Use <code>host:/path</code>, or <code>:/path</code> for{" "}
              <strong>{defaultHost}</strong>. Read over SSH.
            </>
          ) : (
            <>
              Use <code>host:/path</code> (set a default host in Settings to omit it). Read
              over SSH.
            </>
          )}
        </p>
        <div className="remote-prompt-actions">
          <button className="remote-prompt-cancel" onClick={() => setRemotePrompt(false)}>
            Cancel
          </button>
          <button className="remote-prompt-open" onClick={submit} disabled={!value.trim()}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
