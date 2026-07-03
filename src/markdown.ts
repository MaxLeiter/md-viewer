import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import footnote from "markdown-it-footnote";
import { full as emoji } from "markdown-it-emoji";
import githubAlerts from "markdown-it-github-alerts";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import { createHighlighter, bundledLanguages, type Highlighter, type BundledLanguage } from "shiki";

/**
 * DOMPurify defaults plus the tauri asset: protocol (local images), minus
 * <style> so a document can't restyle the app chrome. Raw HTML in markdown is
 * GitHub-style: rendered, but only after passing through this sanitizer.
 *
 * shiki emits inline `style` attributes carrying CSS custom properties
 * (--shiki-light, --shiki-dark). DOMPurify allows the `style` attribute by
 * default and keeps custom-property declarations, so no extra config is needed.
 */
const SANITIZE_OPTIONS = {
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|tel|callto|sms|asset|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_TAGS: ["style"],
};

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
}

type Token = ReturnType<MarkdownIt["parse"]>[number];

/** Don't try to syntax-highlight pathologically large code blocks. */
const HIGHLIGHT_LIMIT = 100_000;

/* ---------------------------------------------------------------------------
   Syntax highlighting (shiki, dual-themed via CSS variables).

   shiki's `createHighlighter` is async (it loads TextMate grammars + themes),
   but `codeToHtml` is sync once the highlighter is ready. We bootstrap once at
   module load with a curated preload set; unknown languages encountered later
   are lazy-loaded and trigger a re-render.
--------------------------------------------------------------------------- */

const PRELOAD_LANGS: BundledLanguage[] = [
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "rust",
  "go",
  "java",
  "cpp",
  "c",
  "csharp",
  "swift",
  "kotlin",
  "ruby",
  "php",
  "bash",
  "shell",
  "json",
  "yaml",
  "toml",
  "xml",
  "html",
  "css",
  "sql",
  "markdown",
  "dockerfile",
  "makefile",
  "diff",
];

const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

let highlighter: Highlighter | null = null;
const loadedLangs = new Set<string>();
const pendingLangs = new Set<string>();
const rerenderListeners = new Set<() => void>();

function notifyRerender() {
  blockCache.clear();
  for (const cb of rerenderListeners) cb();
}

/** Subscribe to "highlighter changed" events (initial ready, new lang loaded). */
export function subscribeRerender(cb: () => void): () => void {
  rerenderListeners.add(cb);
  return () => rerenderListeners.delete(cb);
}

createHighlighter({
  themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark],
  langs: PRELOAD_LANGS,
})
  .then((h) => {
    highlighter = h;
    for (const lang of PRELOAD_LANGS) loadedLangs.add(lang);
    notifyRerender();
  })
  .catch((err) => {
    console.error("shiki: failed to initialize", err);
  });

function loadLangLazy(lang: string) {
  if (!highlighter || pendingLangs.has(lang) || loadedLangs.has(lang)) return;
  if (!(lang in bundledLanguages)) return;
  pendingLangs.add(lang);
  highlighter
    .loadLanguage(lang as BundledLanguage)
    .then(() => {
      pendingLangs.delete(lang);
      loadedLangs.add(lang);
      notifyRerender();
    })
    .catch(() => {
      pendingLangs.delete(lang);
    });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Sync syntax highlighter for markdown-it. Returns full `<pre>` so markdown-it
 *  passes it through unwrapped. */
function highlightCode(code: string, lang: string): string {
  if (!lang || code.length > HIGHLIGHT_LIMIT) return "";
  if (!highlighter) return "";
  if (!loadedLangs.has(lang)) {
    loadLangLazy(lang);
    return "";
  }
  try {
    return highlighter.codeToHtml(code, {
      lang,
      themes: SHIKI_THEMES,
      defaultColor: false,
    });
  } catch {
    return "";
  }
}

const md: MarkdownIt = new MarkdownIt({
  // Raw HTML passes through (like GitHub) — every rendered block is DOMPurify-
  // sanitized before it reaches the DOM, so scripts/handlers never survive.
  html: true,
  linkify: true,
  typographer: true,
  highlight: (code, lang) => highlightCode(code, lang),
});

// markdown-it wraps the result in <pre><code> only if our highlighter returned
// content that does not already start with `<pre`. shiki returns its own <pre>,
// so when we return a non-empty string here, the wrapper is skipped. When we
// return "", markdown-it falls back to its default `<pre><code class="language-lang">`.
// That default is fine for un-highlighted code; we don't need to override it.

md.use(taskLists, { label: true }).use(footnote).use(emoji).use(githubAlerts);

// Local image paths (relative to the document, or absolute) are rewritten to
// the asset protocol so the webview can actually load them. Remote URLs pass
// through untouched.
const renderImage =
  md.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  // For export we keep the original src (portable relative/absolute paths)
  // rather than the in-app asset:// URL, which only resolves inside the app.
  if ((env as { exporting?: boolean }).exporting) {
    return renderImage(tokens, idx, options, env, self);
  }
  if (src && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
    const baseDir = (env as { baseDir?: string | null }).baseDir ?? null;
    const absolute = src.startsWith("/")
      ? src
      : baseDir
        ? `${baseDir}/${decodeURI(src)}`
        : null;
    if (absolute) token.attrSet("src", convertFileSrc(absolute));
  } else if (/^file:\/\//i.test(src)) {
    token.attrSet("src", convertFileSrc(decodeURI(src.replace(/^file:\/\//i, ""))));
  }
  return renderImage(tokens, idx, options, env, self);
};

/* ---------------------------------------------------------------------------
   YAML frontmatter: stripped from the markdown body and rendered as a
   properties card at the top of the preview.
--------------------------------------------------------------------------- */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function renderFrontmatter(block: string): string {
  const esc = escapeHtml;
  const rows: [string, string][] = [];
  let parseable = true;

  for (const raw of block.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(raw);
    if (kv) {
      rows.push([kv[1], kv[2].replace(/^["']|["']$/g, "")]);
    } else if (/^\s+-\s+/.test(raw) && rows.length) {
      const item = raw.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "");
      const last = rows[rows.length - 1];
      last[1] = last[1] ? `${last[1]}, ${item}` : item;
    } else if (/^\s+\S/.test(raw) && rows.length) {
      const last = rows[rows.length - 1];
      last[1] = `${last[1]} ${raw.trim()}`.trim();
    } else {
      parseable = false;
      break;
    }
  }

  if (!parseable || rows.length === 0) {
    return `<section class="frontmatter"><pre>${esc(block)}</pre></section>`;
  }
  const body = rows
    .map(
      ([key, value]) =>
        `<div class="frontmatter-row"><span class="frontmatter-key">${esc(key)}</span><span class="frontmatter-value">${value ? esc(value) : "—"}</span></div>`,
    )
    .join("");
  return `<section class="frontmatter">${body}</section>`;
}

/**
 * Block-level render cache.
 *
 * The document is parsed as a whole (markdown is context-sensitive), but
 * rendering, syntax highlighting, and sanitizing happen per top-level block
 * and are cached by the block's source text. While typing, only the block
 * being edited misses the cache — everything else is a string lookup.
 *
 * The cache is regenerated each render to only hold blocks present in the
 * current document, so it can't grow without bound. It's also cleared whenever
 * the shiki highlighter loads a new language (notifyRerender).
 */
let blockCache = new Map<string, string>();
let referencesFingerprint = "";

/** Group a flat token stream into top-level block runs (nesting depth 0). */
function groupTopLevel(tokens: Token[]): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    current.push(token);
    depth += token.nesting;
    if (depth === 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Character offset of the start of each line, plus a final end-of-source entry. */
function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) offsets.push(i + 1);
  }
  offsets.push(source.length);
  return offsets;
}

/**
 * Render a markdown document to a list of sanitized HTML strings, one per
 * top-level block, in document order.
 */
export function renderBlocks(source: string, baseDir: string | null = null): string[] {
  let body = source;
  let frontmatterHtml: string | null = null;
  const frontmatter = FRONTMATTER_RE.exec(source);
  if (frontmatter) {
    frontmatterHtml = sanitize(renderFrontmatter(frontmatter[1]));
    body = source.slice(frontmatter[0].length);
  }

  const env: { references?: Record<string, unknown>; baseDir?: string | null } = { baseDir };
  const tokens = md.parse(body, env);

  // Reference definitions ([id]: url) can change how *other* blocks render,
  // so a change to them invalidates the whole cache. They rarely change.
  const refs = env.references ? JSON.stringify(env.references) : "";
  if (refs !== referencesFingerprint) {
    blockCache.clear();
    referencesFingerprint = refs;
  }

  const groups = groupTopLevel(tokens);
  const offsets = lineOffsets(body);
  const lastLine = offsets.length - 1;

  const nextCache = new Map<string, string>();
  const htmls: string[] = [];

  for (const group of groups) {
    const first = group[0];
    let key: string;
    if (first.map) {
      let endLine = first.map[1];
      for (const token of group) {
        if (token.map && token.map[1] > endLine) endLine = token.map[1];
      }
      const start = offsets[Math.min(first.map[0], lastLine)];
      const end = offsets[Math.min(endLine, lastLine)];
      key = body.slice(start, end);
    } else {
      key = "tok:" + group.map((t) => `${t.type}${t.content}`).join(" ");
    }

    // Relative image paths resolve against the document's directory, so cache
    // entries must not be shared across documents in different folders.
    key = `${baseDir ?? ""} ${key}`;

    let html = nextCache.get(key) ?? blockCache.get(key);
    if (html === undefined) {
      html = sanitize(md.renderer.render(group, md.options, env));
    }
    nextCache.set(key, html);
    htmls.push(html);
  }

  blockCache = nextCache;
  return frontmatterHtml ? [frontmatterHtml, ...htmls] : htmls;
}

/**
 * Render a whole document to a single sanitized HTML string for export.
 * Images keep their original src so the output is portable; no block cache.
 */
export function renderDocumentHtml(source: string): string {
  let body = source;
  let frontmatterHtml = "";
  const frontmatter = FRONTMATTER_RE.exec(source);
  if (frontmatter) {
    frontmatterHtml = sanitize(renderFrontmatter(frontmatter[1]));
    body = source.slice(frontmatter[0].length);
  }
  const env = { exporting: true };
  return frontmatterHtml + sanitize(md.render(body, env));
}
