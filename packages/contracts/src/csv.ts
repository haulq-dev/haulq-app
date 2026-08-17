/**
 * CSV parsing and dialect detection.
 *
 * Written by hand rather than pulled from npm, for a reason that is about the
 * problem rather than about dependencies: the failure mode that matters here is
 * not "the parser was wrong", it is "the parser silently did something
 * reasonable with an unreasonable file." A carrier's export from their old
 * dispatch software has a title row above the headers, a totals row at the
 * bottom, three date formats, and a "Truck" column containing a driver's name.
 * Handling that needs the parser to report what it decided and why, which is a
 * different interface from `parse(string): string[][]`.
 *
 * Lives in `contracts` so the web app can parse the file locally and show the
 * mapping screen before uploading anything. A round-trip to see whether the
 * headers were guessed right is a bad first experience for the one workflow
 * that Phase 0's exit gate depends on.
 *
 * The parser is deliberately tolerant. It never throws on malformed input — it
 * records the problem against the row and carries on, because failing the whole
 * import on row 400 of 900 is how a carrier decides this was not worth it.
 */

export interface CsvDialect {
  delimiter: string;
  /** Zero-based index of the header row within the raw lines. */
  headerRow: number;
  /** True when a UTF-8 BOM was stripped. Worth surfacing; Excel adds them. */
  hadBom: boolean;
  /** Rows above the header that were skipped, e.g. a report title. */
  skippedPreamble: string[];
}

export interface CsvRow {
  /** 1-based, counted from the first data row after the header. */
  rowNumber: number;
  cells: Record<string, string>;
  /** Structural problems: too few or too many columns for the header. */
  issues: string[];
}

export interface ParsedCsv {
  dialect: CsvDialect;
  headers: string[];
  rows: CsvRow[];
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Split one line, honouring quotes.
 *
 * Kept separate from the record splitter because delimiter detection needs to
 * try several delimiters on the same text without committing to one.
 */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // "" inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      field = '';
      continue;
    }
    if (ch === delimiter) {
      out.push(field.trim());
      field = '';
      continue;
    }
    field += ch;
  }

  out.push(field.trim());
  return out;
}

/**
 * Split the text into records, honouring quoted fields that span lines.
 *
 * A delivery instruction with an embedded newline is common and, unhandled,
 * turns one load into three broken rows.
 */
function splitRecords(text: string): string[] {
  const records: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }

    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      records.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.length > 0) records.push(current);
  return records;
}

/**
 * Guess the delimiter.
 *
 * Chosen by consistency of field count across the first several lines, not by
 * raw frequency. Frequency picks the comma out of `"Smith, John"` in a
 * semicolon-delimited file; consistency does not, because splitting on the
 * wrong delimiter produces a different column count on nearly every line.
 */
export function detectDelimiter(lines: string[]): string {
  const sample = lines.filter((l) => l.trim().length > 0).slice(0, 20);
  if (sample.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = sample.map((l) => splitLine(l, delimiter).length);
    const max = Math.max(...counts);
    if (max < 2) continue;

    const modal = counts.filter((c) => c === max).length / counts.length;
    // Consistency first, column count as the tiebreak. A file that splits into
    // 9 identical columns beats one that splits into 2.
    const score = modal * 100 + max;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/**
 * Find the header row.
 *
 * Exports routinely open with a report title, a date range, and a blank line
 * before the real headers. The header is taken to be the first row that splits
 * into the file's modal column count and whose cells look like labels rather
 * than data — mostly non-numeric, mostly non-empty.
 */
export function detectHeaderRow(lines: string[], delimiter: string): number {
  const counts = lines.map((l) =>
    l.trim() === '' ? 0 : splitLine(l, delimiter).length,
  );
  const modal = mode(counts.filter((c) => c > 1));

  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (counts[i] !== modal) continue;

    const cells = splitLine(lines[i]!, delimiter);
    const nonEmpty = cells.filter((c) => c !== '').length;
    const numeric = cells.filter((c) => c !== '' && isNumericish(c)).length;

    // Labels: most cells filled, few of them numbers.
    if (nonEmpty >= Math.ceil(modal * 0.6) && numeric <= Math.floor(modal * 0.3)) {
      return i;
    }
  }

  return counts.findIndex((c) => c === modal);
}

function mode(ns: number[]): number {
  const counts = new Map<number, number>();
  for (const n of ns) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [n, c] of counts) {
    if (c > bestCount) {
      best = n;
      bestCount = c;
    }
  }
  return best;
}

function isNumericish(s: string): boolean {
  return /^[$(]?-?[\d,]+(\.\d+)?\)?%?$/.test(s.trim());
}

/**
 * Make headers usable as object keys without losing them.
 *
 * Duplicates get a suffix rather than overwriting each other — a file with two
 * columns called "Date" would otherwise silently drop one, and which one it
 * drops depends on order.
 */
function normalizeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base} (${n + 1})`;
  });
}

export function parseCsv(text: string): ParsedCsv {
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);

  const records = splitRecords(text);
  const delimiter = detectDelimiter(records);
  const headerRow = Math.max(0, detectHeaderRow(records, delimiter));

  const headers = normalizeHeaders(splitLine(records[headerRow] ?? '', delimiter));
  const rows: CsvRow[] = [];

  for (let i = headerRow + 1; i < records.length; i++) {
    const line = records[i]!;
    if (line.trim() === '') continue;

    const cells = splitLine(line, delimiter);
    const issues: string[] = [];

    // A trailing "Totals" row is the classic case: one or two populated cells
    // where the header has nine. Skipped rather than reported, because
    // reporting it as an error on every import trains people to ignore errors.
    const populated = cells.filter((c) => c !== '').length;
    if (populated <= 2 && headers.length > 4) continue;

    if (cells.length > headers.length) {
      issues.push(
        `Row has ${cells.length} values but the header has ${headers.length}. ` +
          `The extra values were ignored — usually an unquoted comma inside a field.`,
      );
    } else if (cells.length < headers.length) {
      issues.push(
        `Row has ${cells.length} values but the header has ${headers.length}. ` +
          `The missing columns were left empty.`,
      );
    }

    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = cells[idx] ?? '';
    });

    rows.push({ rowNumber: rows.length + 1, cells: record, issues });
  }

  return {
    dialect: {
      delimiter,
      headerRow,
      hadBom,
      skippedPreamble: records.slice(0, headerRow).filter((l) => l.trim() !== ''),
    },
    headers,
    rows,
  };
}
