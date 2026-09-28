import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings";
import { confirmOverwrite, listRemoteDir } from "../ipc";
import type { RemoteListing } from "../ipc";
import { isValidHost } from "../remote";
import { basename, displayTitle } from "../types";

const HOST_KEY = "remoteBrowserHost";
const dirKey = (host: string) => `remoteBrowserDir:${host}`;
const DOC_RE = /\.(md|markdown|mdown|mkdn|mkd|txt|csv|tsv)$/i;
/** `host:/path` or `host:~/path` pasted into the path bar switches host too. */
const SPEC_RE = /^([A-Za-z0-9._@[\]-]+):((?:~|\/).*)$/;

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function FolderIcon() {
  return (
    <svg width="14" height="12" viewBox="0 0 16 13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M1.5 1h4.3l1.5 1.6h7.2c.6 0 1 .4 1 1V11c0 .6-.4 1-1 1H1.5c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1Z"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 15" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        d="M1.5.8h6l3.7 3.7v9c0 .4-.3.7-.7.7h-9a.7.7 0 0 1-.7-.7V1.5c0-.4.3-.7.7-.7Z"
      />
    </svg>
  );
}

/**
 * Remote file browser, shared by "Open Remote…" and "Save to Remote…". Lists
 * directories over the system `ssh` (so ~/.ssh/config aliases and proxies
 * apply). Remembers the last host and, per host, the last folder.
 */
export function RemoteBrowser() {
  const mode = useStore((s) => s.remoteBrowser);
  // Mount fresh per open so state (listing, drafts) always starts clean.
  return mode ? <Browser mode={mode} /> : null;
}

function Browser({ mode }: { mode: "open" | "save" }) {
  const close = () => useStore.getState().setRemoteBrowser(null);

  // Starting point: saving a doc that already lives remotely starts next to it;
  // otherwise the last host/folder used, then the configured default host.
  const [initial] = useState(() => {
    const s = useStore.getState();
    const doc = s.docs[s.activeId];
    const defaultHost = useSettings.getState().settings.defaultRemoteHost;
    if (mode === "save" && doc?.remote) {
      return { host: doc.remote.host, dir: parentOf(doc.remote.path), name: basename(doc.remote.path) };
    }
    const host = localStorage.getItem(HOST_KEY) || defaultHost || "";
    const title = doc ? displayTitle(doc).replace(/[/\\:]/g, "-") : "Untitled";
    const name = doc?.path ? basename(doc.path) : /\.\w+$/.test(title) ? title : `${title}.md`;
    return { host, dir: (host && localStorage.getItem(dirKey(host))) || "~", name };
  });

  const [host, setHost] = useState(initial.host);
  const [hostDraft, setHostDraft] = useState(initial.host);
  const [pathDraft, setPathDraft] = useState(initial.dir);
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [fileName, setFileName] = useState(initial.name);
  const request = useRef(0);

  const load = useCallback(async (h: string, dir: string) => {
    if (!isValidHost(h)) {
      setListing(null);
      setError(h ? `Invalid SSH host: ${h}` : "Enter an SSH host (an alias from ~/.ssh/config works).");
      return;
    }
    // Ignore responses from superseded requests (fast clicking through folders).
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listRemoteDir(h, dir);
      if (id !== request.current) return;
      result.entries.sort((a, b) =>
        a.isDir !== b.isDir
          ? a.isDir
            ? -1
            : 1
          : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      );
      setListing(result);
      setPathDraft(result.dir);
      localStorage.setItem(HOST_KEY, h);
      localStorage.setItem(dirKey(h), result.dir);
    } catch (err) {
      if (id === request.current) setError(String(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initial.host, initial.dir);
  }, [load, initial]);

  // Escape closes (capture phase, so it beats other window-level handlers).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      useStore.getState().setRemoteBrowser(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const switchHost = (next: string) => {
    const h = next.trim();
    setHost(h);
    setHostDraft(h);
    void load(h, localStorage.getItem(dirKey(h)) || "~");
  };

  const openFile = (h: string, path: string) => {
    close();
    void useStore.getState().openRemote(h, path);
  };

  const save = async (name = fileName.trim()) => {
    if (!listing || !name) return;
    const target = name.startsWith("/") || name.startsWith("~") ? name : joinPath(listing.dir, name);
    const exists = listing.entries.some((e) => !e.isDir && e.name === name);
    if (exists && !(await confirmOverwrite(name))) return;
    const s = useStore.getState();
    if (await s.saveToRemote(s.activeId, host, target)) close();
  };

  // Path bar: a folder navigates; a file path opens it (or, when saving,
  // selects its folder + name); a pasted `host:/path` switches host too.
  const submitPath = () => {
    let h = host;
    let p = pathDraft.trim() || "~";
    const spec = SPEC_RE.exec(p);
    if (spec && isValidHost(spec[1])) {
      h = spec[1];
      p = spec[2];
      setHost(h);
      setHostDraft(h);
    }
    if (DOC_RE.test(p)) {
      if (mode === "open") return openFile(h, p);
      setFileName(basename(p));
      p = parentOf(p);
    }
    void load(h, p);
  };

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));
  const dir = listing?.dir ?? null;

  return (
    <div className="settings-backdrop" onClick={close}>
      <div className="remote-prompt remote-browser" onClick={(event) => event.stopPropagation()}>
        <div className="rb-header">
          <span className="remote-prompt-label">
            {mode === "open" ? "Open remote file" : "Save to remote"}
          </span>
          <label className="rb-hidden-toggle">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            Hidden files
          </label>
        </div>

        <div className="rb-location">
          <input
            className="remote-prompt-input rb-host"
            placeholder="host"
            value={hostDraft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setHostDraft(event.target.value)}
            onBlur={() => hostDraft.trim() !== host && switchHost(hostDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                switchHost(hostDraft);
              }
            }}
          />
          <span className="rb-colon">:</span>
          <input
            className="remote-prompt-input rb-path"
            placeholder="~/ or /abs/path (or paste host:/path)"
            value={pathDraft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitPath();
              }
            }}
          />
          <button
            className="rb-icon-btn"
            data-tip="Home"
            onClick={() => void load(host, "~")}
          >
            ~
          </button>
        </div>

        <div className="rb-list" aria-busy={loading}>
          {error ? (
            <div className="rb-status rb-error">{error}</div>
          ) : !listing ? (
            <div className="rb-status">Connecting…</div>
          ) : (
            <>
              {dir !== "/" && (
                <div className="rb-row rb-dir" onClick={() => void load(host, parentOf(dir!))}>
                  <FolderIcon />
                  <span className="rb-name">..</span>
                </div>
              )}
              {entries.map((entry) => {
                const doc = DOC_RE.test(entry.name);
                const selected = mode === "save" && !entry.isDir && entry.name === fileName;
                return (
                  <div
                    key={entry.name}
                    className={`rb-row${entry.isDir ? " rb-dir" : doc ? " rb-doc" : " rb-other"}${
                      selected ? " selected" : ""
                    }`}
                    title={entry.name}
                    onClick={() => {
                      if (entry.isDir) void load(host, joinPath(listing.dir, entry.name));
                      else if (mode === "open") openFile(host, joinPath(listing.dir, entry.name));
                      else setFileName(entry.name);
                    }}
                    onDoubleClick={() => {
                      if (!entry.isDir && mode === "save") void save(entry.name);
                    }}
                  >
                    {entry.isDir ? <FolderIcon /> : <FileIcon />}
                    <span className="rb-name">{entry.name}</span>
                  </div>
                );
              })}
              {entries.length === 0 && <div className="rb-status">Empty folder</div>}
            </>
          )}
          {loading && listing && <div className="rb-loading" />}
        </div>

        {mode === "save" && (
          <div className="rb-save">
            <span className="rb-save-label">Name</span>
            <input
              className="remote-prompt-input"
              value={fileName}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoFocus
              onChange={(event) => setFileName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </div>
        )}

        <div className="remote-prompt-actions">
          <span className="rb-where">{dir ? `${host}:${dir}` : ""}</span>
          <button className="remote-prompt-cancel" onClick={close}>
            Cancel
          </button>
          {mode === "save" && (
            <button
              className="remote-prompt-open"
              onClick={() => void save()}
              disabled={!listing || !fileName.trim()}
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
