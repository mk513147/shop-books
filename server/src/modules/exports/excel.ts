import ExcelJS from 'exceljs';
import { REPORTING_TIME_ZONE } from '../../config/constants.js';

/**
 * Workbook helpers shared by every export. Values come from the report services as decimal
 * strings; they are written as plain numbers only for display/sorting in Excel (≤ 14 significant
 * digits, so every NUMERIC(14,2) value round-trips exactly). Totals are the backend's figures,
 * not spreadsheet formulas.
 */

export const MONEY_FORMAT = '"₹"#,##0.00;[Red]-"₹"#,##0.00';
export const DATE_FORMAT = 'dd-mmm-yyyy';

/**
 * Formula-injection guard: user-controlled text starting with = + - @ TAB or CR is written with a
 * leading apostrophe, and every text cell is a plain string (never a formula object), so Excel and
 * LibreOffice display it as text and never evaluate it.
 */
export function safeText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function moneyValue(amount: string | null | undefined): number | null {
  if (amount === null || amount === undefined || amount === '') return null;
  return Number(amount);
}

/** 'YYYY-MM-DD' -> a Date at UTC midnight (ExcelJS converts dates to serials in UTC). */
export function dateValue(date: string | null | undefined): Date | null {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function generatedStamp(now = new Date()): string {
  return `${new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: REPORTING_TIME_ZONE }).format(now)} IST`;
}

export interface ReportMeta {
  shopName: string;
  title: string;
  /** e.g. "1 Nov 2026 – 30 Nov 2026" or "All recorded transactions". */
  period: string;
  /** Active filters as label/value pairs (values are user-controlled: escaped). */
  filters?: [string, string][];
  /** Explanatory lines (definitions, e.g. "Supplier payments are not expenses"). */
  notes?: string[];
}

export type ColumnType = 'text' | 'money' | 'date' | 'int' | 'percent';
export interface Column<T> {
  header: string;
  width: number;
  type: ColumnType;
  value: (row: T) => string | number | null | undefined;
}

export function newWorkbook(shopName: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = shopName;
  wb.created = new Date();
  return wb;
}

/** Excel limits sheet names to 31 characters without []:*?/\ */
function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);
}

/**
 * Adds a sheet: header block (shop, title, period, generated time, currency, filters, notes),
 * then a table with bold, frozen header row and an auto-filter, then an optional bold totals row.
 */
export function addTableSheet<T>(
  wb: ExcelJS.Workbook,
  name: string,
  meta: ReportMeta,
  columns: Column<T>[],
  rows: T[],
  totals?: Partial<Record<number, string | number | null>> & { label?: string },
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheetName(name));
  ws.columns = columns.map((c) => ({ width: c.width }));
  const head: [string, string][] = [
    ['Shop', meta.shopName],
    ['Report', meta.title],
    ['Period', meta.period],
    ['Generated', generatedStamp()],
    ['Currency', 'INR (₹)'],
    ...(meta.filters ?? []).map(([k, v]) => [k, v] as [string, string]),
  ];
  for (const [label, value] of head) {
    const row = ws.addRow([label, safeText(value)]);
    row.getCell(1).font = { bold: true, color: { argb: 'FF5B6472' } };
    if (label === 'Report') row.getCell(2).font = { bold: true, size: 13 };
  }
  for (const note of meta.notes ?? []) {
    const row = ws.addRow([safeText(note)]);
    row.getCell(1).font = { italic: true, color: { argb: 'FF5B6472' } };
  }
  ws.addRow([]);

  const headerRow = ws.addRow(columns.map((c) => c.header));
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  const headerIndex = headerRow.number;

  for (const item of rows) {
    const row = ws.addRow(
      columns.map((c) => {
        const v = c.value(item);
        if (v === null || v === undefined || v === '') return null;
        if (c.type === 'money') return moneyValue(String(v));
        if (c.type === 'date') return dateValue(String(v));
        if (c.type === 'int') return Number(v);
        if (c.type === 'percent') return Number(v) / 100;
        return safeText(String(v));
      }),
    );
    columns.forEach((c, i) => formatCell(row.getCell(i + 1), c.type));
  }

  if (totals) {
    const values = columns.map((c, i) => {
      const v = totals[i];
      if (v === undefined || v === null) return null;
      return c.type === 'money' ? moneyValue(String(v)) : c.type === 'int' ? Number(v) : safeText(String(v));
    });
    values[0] = values[0] ?? totals.label ?? 'Total';
    const row = ws.addRow(values);
    row.font = { bold: true };
    row.border = { top: { style: 'thin' } };
    columns.forEach((c, i) => formatCell(row.getCell(i + 1), c.type));
  }

  ws.views = [{ state: 'frozen', ySplit: headerIndex }];
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: headerIndex, column: 1 }, to: { row: headerIndex + rows.length, column: columns.length } };
  }
  return ws;
}

function formatCell(cell: ExcelJS.Cell, type: ColumnType): void {
  if (type === 'money') cell.numFmt = MONEY_FORMAT;
  if (type === 'date') cell.numFmt = DATE_FORMAT;
  if (type === 'percent') cell.numFmt = '0.0%';
  if (type === 'text') cell.numFmt = '@';
}

/** A two-column "label / value" sheet (summaries). */
export function addKeyValueSheet(
  wb: ExcelJS.Workbook,
  name: string,
  meta: ReportMeta,
  sections: { heading: string; rows: [string, string | number, ColumnType?][] }[],
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheetName(name));
  ws.columns = [{ width: 46 }, { width: 22 }];
  const head: [string, string][] = [
    ['Shop', meta.shopName],
    ['Report', meta.title],
    ['Period', meta.period],
    ['Generated', generatedStamp()],
    ['Currency', 'INR (₹)'],
  ];
  for (const [label, value] of head) {
    const row = ws.addRow([label, safeText(value)]);
    row.getCell(1).font = { bold: true, color: { argb: 'FF5B6472' } };
  }
  for (const note of meta.notes ?? []) ws.addRow([safeText(note)]).getCell(1).font = { italic: true, color: { argb: 'FF5B6472' } };
  for (const section of sections) {
    ws.addRow([]);
    const h = ws.addRow([section.heading]);
    h.font = { bold: true, size: 12, color: { argb: 'FF0F766E' } };
    for (const [label, value, type = 'money'] of section.rows) {
      const v = type === 'money' ? moneyValue(String(value)) : type === 'int' ? Number(value) : safeText(String(value));
      const row = ws.addRow([safeText(label), v]);
      formatCell(row.getCell(2), type);
    }
  }
  return ws;
}

export async function workbookBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}
