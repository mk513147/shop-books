import { crc32, deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';

/**
 * Synthetic workbooks for the product import tests. They REPRODUCE THE DOCUMENTED SHAPE of the
 * shop's "Copy" sheet (section label rows, repeated header rows, a copied side-by-side block,
 * "SL"/"D"/"MD" sizes, "150G" in names, "176/192" pages, "50,3/pc" and "10/Pc" price cells, an
 * MRP of 0, two prices for the same item, PAPERKARFT/PAPERKART spellings, trailing spaces) without
 * copying the real file. A second sheet stands for unrelated personal data that must never be stored.
 */

type Cell = string | number | null;

export const COPY_ROWS: { row: number; cells: Cell[] }[] = [
  { row: 1, cells: ['COPY', 'COPY', 'COPY', 'COPY', 'COPY'] },
  { row: 2, cells: ['CLASSMATE', 'CLASSMATE', 'CLASSMATE', 'CLASSMATE', 'CLASSMATE'] },
  { row: 3, cells: ['NAME', 'PAGE ', 'SIZE', 'MRP', 'SP'] },
  { row: 4, cells: ['CLASSMATE', 172, 'SL', 48, 45] },
  { row: 5, cells: ['CLASSMATE REGISTER', 140, 'A4', 55, 50] },
  { row: 6, cells: ['CLASSMATE REGISTER', 140, 'A4', 65, 55] },
  { row: 7, cells: ['CLASSMATE SPIRAL', 160, 'SL', 65, 60] },
  { row: 9, cells: ['APPLE', 'APPLE', 'APPLE', 'APPLE', 'APPLE'] },
  { row: 10, cells: ['APPLE ', '120/140', 'SL', 40, 30] },
  { row: 11, cells: ['APPLE ROUGH', 92, 'A4', 50, 20] },
  { row: 12, cells: ['PRACTICAL', 'PRACTICAL', 'PRACTICAL', 'PRACTICAL', 'PRACTICAL'] },
  { row: 13, cells: ['NAME', 'PAGE ', 'SIZE', 'MRP', 'SP'] },
  { row: 14, cells: ['CLASSMATE ', 100, 'A4', 70, 60] },
  { row: 15, cells: ['PILOT', 104, 'A4', 75, 50] },
  { row: 16, cells: ['DRAWING COPY', 'DRAWING COPY', 'DRAWING COPY', 'DRAWING COPY', 'DRAWING COPY'] },
  { row: 17, cells: ['NAME', 'PAGE ', 'SIZE', 'MRP', 'SP'] },
  { row: 18, cells: ['DOMS SPIRAL 150G', 36, 'A5', 80, 65] },
  { row: 19, cells: ['CAMEL SPIRAL 270G', 15, 'A4', 150, 140] },
  { row: 20, cells: ['SCRAP/GRAPH/DIARY/PAPER', 'SCRAP/GRAPH/DIARY/PAPER', 'SCRAP/GRAPH/DIARY/PAPER', 'SCRAP/GRAPH/DIARY/PAPER', 'SCRAP/GRAPH/DIARY/PAPER'] },
  { row: 21, cells: ['CANSON DRAWING', 12, 'A4', 200, '170, 15/pc'] },
  { row: 22, cells: ['NORMAL 200G', 20, 'A3', 200, '10/Pc'] },
  { row: 23, cells: ['MY SCHOLAR ', 160, 'D', 0, 40] },
  { row: 24, cells: ['PAPERKARFT SPIRAL', 160, 'D', 110, 100] },
  { row: 25, cells: ['PAPERKART SPIRAL', 176, 'MD', 65, 60] },
  { row: 26, cells: ['ODDY DESIGN', 20, 'A4', 80, '50,3/pc'] },
  { row: 27, cells: ['=HYPERLINK("http://x.test","click")', 1, 'A4', 10, 10] },
];

/** The "Copy" sheet: block A–E, plus G–K repeating rows 12–26 of A–E (like the real file). */
export async function copySheetWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Copy');
  for (const { row, cells } of COPY_ROWS) {
    cells.forEach((value, i) => {
      if (value !== null) ws.getRow(row).getCell(i + 1).value = value;
    });
  }
  // Duplicate block at G2:K16 = rows 12..26 of A..E.
  const copied = COPY_ROWS.filter((r) => r.row >= 12 && r.row <= 26);
  for (const { row, cells } of copied) {
    cells.forEach((value, i) => {
      if (value !== null) ws.getRow(row - 10).getCell(i + 7).value = value;
    });
  }
  ws.mergeCells('A1:E1');
  const other = wb.addWorksheet('Daily expenses');
  other.addRow(['PRIVATE', 'SHOULD NOT BE STORED']);
  other.addRow(['Rent', 12000]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A plain template-style workbook. */
export async function templateWorkbook(rows: Cell[][], header: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- A minimal ZIP writer for hostile archives ------------------------------------------------------

export interface ZipFile {
  name: string;
  data: Buffer;
  /** Store instead of deflate. */
  stored?: boolean;
  /** Write this as the declared uncompressed size instead of the real one (a lying header). */
  declaredSize?: number;
}

export function buildZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = f.stored ? f.data : deflateRawSync(f.data);
    const crc = crc32(f.data);
    const size = f.declaredSize ?? f.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(f.stored ? 0 : 8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(f.stored ? 0 : 8, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const WORKBOOK_PARTS: ZipFile[] = [
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
];
