import ExcelJS from 'exceljs';
import { AppError } from '../../utils/errors.js';
import { assertSafeXlsx } from './zipGuard.js';

/**
 * Reading uploaded workbooks. Values are kept AS READ (type + value); nothing is corrected here.
 * Only after the user picks a sheet and a block is anything stored (and then only that block).
 */

export const IMPORT_LIMITS = {
  maxSheets: 20,
  maxDataRows: 2000,
  maxColumns: 30,
  maxCellText: 500,
  /** Rows scanned per sheet when inspecting (formatting can make rowCount huge). */
  maxScanRows: 5000,
  previewRows: 40,
} as const;

/** A raw cell exactly as read: t = n(umber) s(tring) b(oolean) d(ate, ISO) f(ormula: cached result) e(rror). */
export type RawCell =
  | { t: 'n'; v: number }
  | { t: 's'; v: string }
  | { t: 'b'; v: boolean }
  | { t: 'd'; v: string }
  | { t: 'f'; v: string | number | boolean | null; f: string }
  | { t: 'e'; v: string };

export type RawRow = Record<string, RawCell>;

export function columnLetter(index: number): string {
  let n = index;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function columnIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export interface BlockRange {
  firstColumn: number;
  lastColumn: number;
  firstRow: number;
  lastRow: number;
}

export function parseRange(range: string): BlockRange {
  const m = /^([A-Z]{1,3})([0-9]{1,7}):([A-Z]{1,3})([0-9]{1,7})$/.exec(range.trim().toUpperCase());
  if (!m) throw new AppError(400, 'INVALID_RANGE', 'Enter the block as a range like A1:E109');
  const r = { firstColumn: columnIndex(m[1]!), firstRow: Number(m[2]), lastColumn: columnIndex(m[3]!), lastRow: Number(m[4]) };
  if (r.lastColumn < r.firstColumn || r.lastRow < r.firstRow) throw new AppError(400, 'INVALID_RANGE', 'The range must go from top-left to bottom-right');
  if (r.lastColumn - r.firstColumn + 1 > IMPORT_LIMITS.maxColumns) {
    throw new AppError(400, 'RANGE_TOO_WIDE', `Select at most ${IMPORT_LIMITS.maxColumns} columns`);
  }
  return r;
}

export const formatRange = (r: BlockRange) => `${columnLetter(r.firstColumn)}${r.firstRow}:${columnLetter(r.lastColumn)}${r.lastRow}`;

function clip(text: string): string {
  return text.length > IMPORT_LIMITS.maxCellText ? text.slice(0, IMPORT_LIMITS.maxCellText) : text;
}

/** ExcelJS cell value -> RawCell (undefined for an empty cell). */
export function toRawCell(value: ExcelJS.CellValue): RawCell | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? { t: 'n', v: value } : { t: 'e', v: 'not a number' };
  if (typeof value === 'string') return value === '' ? undefined : { t: 's', v: clip(value) };
  if (typeof value === 'boolean') return { t: 'b', v: value };
  if (value instanceof Date) return { t: 'd', v: value.toISOString() };
  if (typeof value === 'object') {
    const o = value as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      const text = (o.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
      return text === '' ? undefined : { t: 's', v: clip(text) };
    }
    if ('formula' in o || 'sharedFormula' in o) {
      const result = o.result;
      const v =
        result === undefined || result === null
          ? null
          : result instanceof Date
            ? result.toISOString()
            : typeof result === 'object'
              ? null
              : (result as string | number | boolean);
      return { t: 'f', v: typeof v === 'string' ? clip(v) : v, f: clip(String(o.formula ?? o.sharedFormula ?? '')) };
    }
    if ('error' in o) return { t: 'e', v: String(o.error) };
    if ('text' in o) {
      const text = String(o.text ?? '');
      return text === '' ? undefined : { t: 's', v: clip(text) };
    }
  }
  return { t: 'e', v: 'unsupported cell' };
}

/** What a person would see in the cell. */
export function cellText(cell: RawCell | undefined): string {
  if (!cell || cell.v === null) return '';
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  if (cell.t === 'd') return cell.v.slice(0, 10);
  return String(cell.v);
}

export async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  assertSafeXlsx(buf);
  const wb = new ExcelJS.Workbook();
  try {
    // ExcelJS's typings predate Node's generic Buffer; the bytes are what it needs.
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new AppError(400, 'INVALID_WORKBOOK', 'The workbook could not be read. Open it in Excel and save it again as .xlsx.');
  }
  if (wb.worksheets.length === 0) throw new AppError(400, 'INVALID_WORKBOOK', 'The workbook has no sheets.');
  if (wb.worksheets.length > IMPORT_LIMITS.maxSheets) {
    throw new AppError(400, 'INVALID_WORKBOOK', `The workbook has too many sheets (at most ${IMPORT_LIMITS.maxSheets}).`);
  }
  return wb;
}

function sheetBounds(ws: ExcelJS.Worksheet): { rows: number; columns: number } {
  return { rows: Math.min(ws.rowCount, IMPORT_LIMITS.maxScanRows), columns: Math.min(ws.columnCount, 200) };
}

function readGrid(ws: ExcelJS.Worksheet, range: BlockRange): Map<number, RawRow> {
  const grid = new Map<number, RawRow>();
  for (let r = range.firstRow; r <= range.lastRow; r++) {
    const row = ws.getRow(r);
    const cells: RawRow = {};
    for (let c = range.firstColumn; c <= range.lastColumn; c++) {
      const raw = toRawCell(row.getCell(c).value);
      if (raw) cells[columnLetter(c)] = raw;
    }
    if (Object.keys(cells).length) grid.set(r, cells);
  }
  return grid;
}

export interface DetectedBlock {
  range: string;
  /** Set when this block repeats rows of another block cell for cell (e.g. a copied table). */
  duplicateOf: string | null;
}

export interface SheetPreview {
  name: string;
  rowCount: number;
  columnCount: number;
  /** First rows as displayed text, columns A.. (only for choosing; nothing is stored). */
  preview: { row: number; cells: string[] }[];
  blocks: DetectedBlock[];
}

/**
 * Column blocks separated by completely empty columns, and which blocks are exact copies of
 * (part of) another block. E.g. a table at A–E with columns G–K repeating rows 56–109 of A–E.
 */
export function detectBlocks(ws: ExcelJS.Worksheet): DetectedBlock[] {
  const { rows, columns } = sheetBounds(ws);
  if (rows === 0 || columns === 0) return [];
  const full = readGrid(ws, { firstRow: 1, lastRow: rows, firstColumn: 1, lastColumn: columns });
  const used = new Set<number>();
  for (const cells of full.values()) for (const letter of Object.keys(cells)) used.add(columnIndex(letter));
  const spans: [number, number][] = [];
  for (let c = 1; c <= columns; c++) {
    if (!used.has(c)) continue;
    const last = spans[spans.length - 1];
    if (last && last[1] === c - 1) last[1] = c;
    else spans.push([c, c]);
  }
  const blocks = spans.map(([from, to]) => {
    const sigs: { row: number; sig: string }[] = [];
    for (let r = 1; r <= rows; r++) {
      const cells = full.get(r);
      if (!cells) continue;
      const texts: string[] = [];
      for (let c = from; c <= to; c++) texts.push(cellText(cells[columnLetter(c)]).trim());
      if (texts.some(Boolean)) sigs.push({ row: r, sig: texts.join('\u0001') });
    }
    return { from, to, sigs };
  });
  return blocks.map((b, i) => {
    const range = b.sigs.length
      ? formatRange({ firstColumn: b.from, lastColumn: b.to, firstRow: b.sigs[0]!.row, lastRow: b.sigs[b.sigs.length - 1]!.row })
      : `${columnLetter(b.from)}1:${columnLetter(b.to)}1`;
    let duplicateOf: string | null = null;
    for (let j = 0; j < blocks.length && !duplicateOf; j++) {
      const other = blocks[j]!;
      if (j === i || other.to - other.from !== b.to - b.from || b.sigs.length === 0 || b.sigs.length > other.sigs.length) continue;
      // Earlier/larger block wins: only the smaller (or later, when equal) copy is flagged.
      if (b.sigs.length === other.sigs.length && j > i) continue;
      for (let start = 0; start + b.sigs.length <= other.sigs.length; start++) {
        if (b.sigs.every((s, k) => s.sig === other.sigs[start + k]!.sig)) {
          duplicateOf = formatRange({
            firstColumn: other.from,
            lastColumn: other.to,
            firstRow: other.sigs[start]!.row,
            lastRow: other.sigs[start + b.sigs.length - 1]!.row,
          });
          break;
        }
      }
    }
    return { range, duplicateOf };
  });
}

/** Inspect step: sheet names, a short preview and detected blocks. Nothing is persisted. */
export async function inspectWorkbook(buf: Buffer): Promise<SheetPreview[]> {
  const wb = await loadWorkbook(buf);
  return wb.worksheets.map((ws) => {
    const { rows, columns } = sheetBounds(ws);
    const width = Math.min(columns, IMPORT_LIMITS.maxColumns);
    const preview: SheetPreview['preview'] = [];
    for (let r = 1; r <= Math.min(rows, IMPORT_LIMITS.previewRows); r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(cellText(toRawCell(row.getCell(c).value)));
      preview.push({ row: r, cells });
    }
    return { name: ws.name, rowCount: ws.rowCount, columnCount: ws.columnCount, preview, blocks: detectBlocks(ws) };
  });
}

export interface ExtractedBlock {
  sheetName: string;
  range: BlockRange;
  headerRow: number;
  header: RawRow;
  /** Every non-empty row of the block except the header row, with original sheet row numbers. */
  rows: { rowNumber: number; cells: RawRow }[];
}

export async function extractBlock(buf: Buffer, sheetName: string, rangeText: string, headerRow: number): Promise<ExtractedBlock> {
  const wb = await loadWorkbook(buf);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new AppError(400, 'SHEET_NOT_FOUND', `There is no sheet called “${sheetName}” in this workbook`);
  const range = parseRange(rangeText);
  if (headerRow < range.firstRow || headerRow > range.lastRow) {
    throw new AppError(400, 'INVALID_HEADER_ROW', 'The header row must be inside the selected block');
  }
  if (range.lastRow - range.firstRow > IMPORT_LIMITS.maxScanRows) {
    throw new AppError(400, 'TOO_MANY_ROWS', `Select at most ${IMPORT_LIMITS.maxScanRows} sheet rows`);
  }
  const grid = readGrid(ws, range);
  const header = grid.get(headerRow) ?? {};
  if (Object.keys(header).length === 0) throw new AppError(400, 'INVALID_HEADER_ROW', 'The header row is empty');
  // Rows above the header are kept too: a section label (e.g. a brand title) may sit there.
  const rows = [...grid.entries()].filter(([r]) => r !== headerRow).map(([rowNumber, cells]) => ({ rowNumber, cells }));
  if (rows.length === 0) throw new AppError(400, 'EMPTY_BLOCK', 'There are no rows below the header row');
  if (rows.length > IMPORT_LIMITS.maxDataRows) {
    throw new AppError(400, 'TOO_MANY_ROWS', `The block has ${rows.length} rows; at most ${IMPORT_LIMITS.maxDataRows} can be imported at once. Split the file.`);
  }
  return { sheetName: ws.name, range, headerRow, header, rows };
}
