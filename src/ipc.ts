import { invoke } from "@tauri-apps/api/core";
import {
  open as openDialog,
  save as saveDialog,
  ask,
  confirm,
  message,
} from "@tauri-apps/plugin-dialog";

const MARKDOWN_FILTER = [
  { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkdn", "mkd", "txt"] },
  { name: "CSV", extensions: ["csv", "tsv"] },
  { name: "All Files", extensions: ["*"] },
];

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents });
}

/** Permit the asset protocol to serve a specific local file (e.g. a dropped image). */
export function allowAsset(path: string): Promise<void> {
  return invoke<void>("allow_asset", { path });
}

/** Whether a local path exists (gating file-link navigation). */
export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/** Rebuild the native File → Open Recent submenu. */
export function setRecentFiles(items: { spec: string; label: string }[]): Promise<void> {
  return invoke<void>("set_recent_files", { items });
}

/** Read a remote file over SSH. */
export function readRemoteFile(host: string, path: string): Promise<string> {
  return invoke<string>("read_remote", { host, path });
}

/** Write a remote file over SSH (atomic on the remote side). */
export function writeRemoteFile(host: string, path: string, contents: string): Promise<void> {
  return invoke<void>("write_remote", { host, path, contents });
}

/** Update native menu accelerators (id → accelerator; empty string clears). */
export function setMenuAccelerators(accelerators: Record<string, string>): Promise<void> {
  return invoke<void>("set_menu_accelerators", { accelerators });
}

/** Tell the backend we're listening; returns files queued before startup. */
export function frontendReady(): Promise<string[]> {
  return invoke<string[]>("frontend_ready");
}

export function quitApp(): Promise<void> {
  return invoke<void>("quit_app");
}

/** Native open dialog. Returns selected paths (possibly empty). */
export async function pickFilesToOpen(): Promise<string[]> {
  const result = await openDialog({ multiple: true, filters: MARKDOWN_FILTER });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

/** Native save dialog. Returns the chosen path or null if cancelled. */
export async function pickSavePath(suggestedName: string): Promise<string | null> {
  const result = await saveDialog({
    defaultPath: suggestedName,
    filters: MARKDOWN_FILTER,
  });
  return result ?? null;
}

/** "Save before closing?" — true means save, false means discard. */
export function askToSave(title: string): Promise<boolean> {
  return ask(`Do you want to save the changes you made to “${title}”?`, {
    title: "Unsaved Changes",
    kind: "warning",
    okLabel: "Save",
    cancelLabel: "Don't Save",
  });
}

/** Confirm quitting/closing with unsaved changes. */
export function confirmDiscardAll(count: number): Promise<boolean> {
  const what = count === 1 ? "1 document has" : `${count} documents have`;
  return confirm(`${what} unsaved changes. Close anyway?`, {
    title: "Unsaved Changes",
    kind: "warning",
    okLabel: "Close",
    cancelLabel: "Cancel",
  });
}

export async function showError(text: string): Promise<void> {
  await message(text, { title: "Markdown", kind: "error" });
}
