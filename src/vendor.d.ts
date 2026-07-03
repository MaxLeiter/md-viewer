declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: (
    md: MarkdownIt,
    options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean },
  ) => void;
  export default plugin;
}

declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";
  export const full: (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export const light: (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export const bare: (md: MarkdownIt, options?: Record<string, unknown>) => void;
}
