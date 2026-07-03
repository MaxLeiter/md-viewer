/**
 * Lightweight CSV/TSV rendering for the preview pane: the document stays raw
 * text (editable in the editor pane); the preview shows it as a table.
 */

const MAX_ROWS = 5000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function detectDelimiter(text: string, path: string | null): string {
  if (path && /\.tsv$/i.test(path)) return "\t";
  const newline = text.indexOf("\n");
  const firstLine = text.slice(0, newline === -1 ? Math.min(text.length, 2000) : newline);
  let best = ",";
  let bestCount = 0;
  for (const candidate of [",", "\t", ";"]) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180-ish parser: quoted fields, escaped quotes, newlines inside quotes. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Render a CSV/TSV source into preview blocks (a meta line and a table). */
export function renderCsvBlocks(source: string, path: string | null): string[] {
  if (!/\S/.test(source)) return [];

  const delimiter = detectDelimiter(source, path);
  const rows = parseCsv(source, delimiter);
  if (rows.length === 0) return [];

  const [header, ...body] = rows;
  const columns = header.length;
  const shown = body.slice(0, MAX_ROWS);
  const truncated = body.length > MAX_ROWS;

  const meta = `<p class="csv-meta">${body.length.toLocaleString()} rows × ${columns.toLocaleString()} columns${
    truncated ? ` · showing the first ${MAX_ROWS.toLocaleString()} rows` : ""
  }</p>`;

  const head = `<thead><tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
  const bodyHtml = shown
    .map((cells) => `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  const table = `<table class="csv-table">${head}<tbody>${bodyHtml}</tbody></table>`;

  return [meta, table];
}
