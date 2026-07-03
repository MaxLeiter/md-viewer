export interface Heading {
  level: number;
  text: string;
  /** 0-based line of the heading in the full document. */
  line: number;
  /** Position among all headings, in document order. */
  index: number;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^(\s*)(```+|~~~+)/;

/** Strip inline emphasis/code markers from heading text for display. */
function cleanHeadingText(raw: string): string {
  return raw
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * Extract ATX headings (`#`…`######`) from markdown, in document order.
 * Skips YAML frontmatter and anything inside fenced code blocks.
 */
export function extractHeadings(source: string): Heading[] {
  let offset = 0;
  const frontmatter = FRONTMATTER_RE.exec(source);
  if (frontmatter) {
    offset = frontmatter[0].split(/\r?\n/).length - 1;
    source = source.slice(frontmatter[0].length);
  }

  const headings: Heading[] = [];
  let fence: string | null = null; // active code-fence marker, if any
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const m = ATX_RE.exec(line);
    if (!m) continue;
    const text = cleanHeadingText(m[2]);
    if (!text) continue;
    headings.push({
      level: m[1].length,
      text,
      line: offset + i,
      index: headings.length,
    });
  }
  return headings;
}
