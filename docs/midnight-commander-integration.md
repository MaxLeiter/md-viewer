# Midnight Commander integration

Browse files in [Midnight Commander](https://midnight-commander.org/) (`mc`) and
open any Markdown file in md-viewer with a keypress — including files on a remote
host, opened **live over SSH** so edits save straight back.

## Why

You want a fast terminal file manager for navigation *and* a real GUI for reading
Markdown, and you want both to work against a remote dev box.

The usual GUI SCP/SFTP clients don't cut it for many remote setups: they ship
their own SSH stack and **ignore `~/.ssh/config`**, so a host alias, a `HostName`
rewrite, or — the common blocker — a `ProxyCommand`/`ProxyJump` never applies.
If your box is only reachable through a proxy command (a bastion, a
websocket/SSM tunnel, a corp jump host), those clients fail with a DNS or
connection error before they ever reach it.

`mc` avoids that because its `sh://` VFS shells out to the **system `ssh`
binary**, which reads `~/.ssh/config` and runs your `ProxyCommand` like any other
`ssh` call. md-viewer's `mdv` launcher does the same for the GUI. So the
combination gives you:

- terminal navigation of local **and** remote trees (`sh://host/path`),
- `F3` quick plain-text render and `F4` syntax-highlighted editing in-terminal,
- `Enter` → the full md-viewer GUI, opening remote files live over SSH (read
  **and** write-back), local files directly.

No FUSE mount, no kernel extension, no second SSH configuration to maintain.

## Prerequisites

- macOS with [Homebrew](https://brew.sh/).
- A working `ssh <host>` for any remote box you want to browse (i.e. your
  `~/.ssh/config` alias, keys, and any `ProxyCommand` already work from a
  terminal). This guide uses `mybox` as the placeholder host alias.
- md-viewer built and its `mdv` launcher on your `PATH` (see the repo README).
  Verify with `mdv --help` or `mdv README.md`.

```sh
brew install midnight-commander pandoc html2text
brew install glow            # optional: styled in-terminal render
```

Put `mdv` on your `PATH` (adjust the source path to your checkout):

```sh
ln -sf "$HOME/md-viewer/scripts/mdv" /opt/homebrew/bin/mdv
```

## 1. The open helper

`mc` hands an external "Open" command a **local temp copy** of a remote file, not
its remote path — so opening that temp in a GUI would be a lossy, view-only
snapshot. This helper reconstructs the real `host:/path` from the panel's `sh://`
directory and calls `mdv` (live remote read/write); for local files it opens the
file directly.

Save as `~/.config/mc/open-md.sh` and `chmod +x` it:

```bash
#!/usr/bin/env bash
# Called by mc as:  open-md.sh <panel-dir %d> <basename %p> <local/temp file %f>
dir="$1"; base="$2"; localf="$3"
reconstruct() {                 # strip vfs prefix -> emit  host:/abs/path/base
  local rest="$1" host rpath
  host="${rest%%/*}"; rpath="/${rest#*/}"
  printf '%s:%s/%s' "$host" "$rpath" "$base"
}
case "$dir" in
  */\#sh:*) exec mdv "$(reconstruct "${dir#*/#sh:}")" ;;   # classic  /#sh:host/...
  sh://*)   exec mdv "$(reconstruct "${dir#sh://}")" ;;    # uri form sh://host/...
  *)        exec open -a md-viewer "$localf" ;;            # local file
esac
```

> Replace `open -a md-viewer` with your app bundle name/path if it differs
> (e.g. `open -a /Applications/Markdown.app`), or just `exec mdv "$localf"`.

## 2. Register Markdown in `mc`

`mc` 4.8.x uses the INI-format extension file `mc.ext.ini` (older guides showing
the `mc.ext` regex format do **not** apply to current releases). To keep every
built-in association, copy the system file to your user config and add a
`[Markdown]` section:

```sh
mkdir -p ~/.config/mc
cp "$(find "$(brew --prefix)" -name mc.ext.ini | head -1)" ~/.config/mc/mc.ext.ini
```

Add this section to `~/.config/mc/mc.ext.ini` (right after the top
`Version=4.0` line so it takes precedence):

```ini
### Markdown ###
[Markdown]
Regex=\\.(md|markdown|mkd|mdown)$
RegexIgnoreCase=true
Open=/Users/YOU/.config/mc/open-md.sh %d %p %f
View=%view{ascii} pandoc -f gfm -t html %f | html2text -utf8
```

- `Open` (**Enter**) → md-viewer GUI, live over SSH for remote files.
- `View` (**F3**) → in-terminal plain-text render. `-utf8` on `html2text`
  prevents em-dash/quote mojibake. `F8` toggles rendered ↔ raw.
- **F4** → `mcedit` with Markdown syntax highlighting, which ships with `mc`
  already — no extra setup.

Use an absolute path in `Open=` (`~` is not expanded there).

## 3. A browse alias (optional)

```sh
# ~/.zshrc  — note: no spaces around '=' in zsh aliases
alias mcc='mc . sh://mybox/home/you/notes'
```

Left panel = local files, right panel = the remote tree. `Tab` switches panels,
`F5` copies between them.

## 4. Default remote host in md-viewer (optional)

md-viewer → Settings (⌘,) → **Remote (SSH) → Default host** = `mybox`. Then
host-less references resolve to it: `mdv :/path/to/file.md`,
`mdviewer://open?path=/abs/path`, and the app's *Open Remote…* accepts just
`:/path`. The mc helper above always passes an explicit host, which overrides the
default, so this is purely for hand-typed use.

## Using it

| Key | Action |
|-----|--------|
| **Enter** on a `.md` | Open in md-viewer GUI (remote = live over SSH, editable) |
| **F3** | Plain-text render in terminal (F8 toggles raw) |
| **F4** | Edit with syntax highlighting |
| `glow -p file.md` | Styled render in terminal (optional) |

## Gotchas

- **`mc` caches `mc.ext.ini`.** After editing it, press `F9 c e` and exit the
  editor, or restart `mc`, for changes to load.
- **Use `Open` on the panel, not `F3`'s viewer.** Inside the F3 viewer, `F4` is
  the Hex toggle, not "edit" — get back to the panel first.
- **A terminal render is not HTML.** `glow`/`pandoc` color and lay out text but a
  TTY has one font size, no images, no real page layout. Use the GUI (`Enter`)
  when you want true rendering.
- **Remote path reconstruction** assumes the panel URL is `sh://host/abs/path`
  (or the classic `/#sh:host/abs/path`). If your `mc` shows a different VFS
  prefix, adjust the `case` arms in `open-md.sh`.
