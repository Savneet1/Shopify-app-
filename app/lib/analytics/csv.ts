/**
 * Phase 11.7 — CSV export with FORMULA-INJECTION protection. A cell whose
 * value begins with = + - @ (or a TAB/CR) is neutralized by prefixing a single
 * quote, so spreadsheet apps never execute it as a formula; quotes, commas and
 * newlines are escaped per RFC 4180. Pure, deterministic, no throw.
 */

// A cell is dangerous if its FIRST NON-WHITESPACE character is one a spreadsheet
// treats as a formula lead (= + - @) or a TAB/CR. Checking past leading
// whitespace closes the " =1+1" / "\t@x" bypass (some apps trim then evaluate).
const DANGEROUS_PREFIX = /^[ \t\r\n]*[=+\-@\t\r]/;

/** Neutralize + escape ONE cell value to a safe CSV field. */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  // Neutralize formula-injection: prefix a single quote if it starts dangerous
  // (at the first non-whitespace character).
  if (DANGEROUS_PREFIX.test(s)) s = "'" + s;
  // RFC 4180 quoting: wrap in quotes and double internal quotes if the field
  // contains a comma, quote, CR or LF.
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Build one CSV line from an array of cell values. */
export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * Build a full CSV string from a header + rows. `maxRows` hard-caps the output
 * (streaming-safe callers can instead iterate csvRow). Always ends with a
 * trailing newline.
 */
export function buildCsv(header: string[], rows: unknown[][], maxRows = 50000): string {
  const capped = rows.slice(0, Math.max(0, Math.floor(maxRows)));
  const lines = [csvRow(header)];
  for (const r of capped) lines.push(csvRow(r));
  return lines.join("\r\n") + "\r\n";
}
