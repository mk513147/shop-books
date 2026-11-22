import { inflateRawSync } from 'node:zlib';
import { AppError } from '../../utils/errors.js';

/**
 * Structural checks of an uploaded .xlsx (a ZIP archive) BEFORE ExcelJS opens it.
 *
 * Why: a small compressed file can expand to gigabytes ("zip bomb") and exhaust the API's memory.
 * The central directory's declared sizes are checked first, then every entry is actually inflated
 * with a hard output cap (zlib maxOutputLength) so a lying header cannot get past either. Macro
 * workbooks (xl/vbaProject.bin), ZIP64, encryption, unsafe names and unknown compression methods
 * are refused. Nothing here touches the disk.
 */

export const XLSX_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxEntries: 300,
  maxEntryBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
} as const;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;

const reject = (message: string) => new AppError(400, 'INVALID_WORKBOOK', message);

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

function findEocd(buf: Buffer): number {
  // EOCD is 22 bytes plus an optional comment of up to 65,535 bytes.
  const start = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

export function readCentralDirectory(buf: Buffer): ZipEntry[] {
  if (buf.length < 22 || buf.readUInt32LE(0) !== SIG_LOCAL) {
    throw reject('This is not an Excel .xlsx file. Password-protected and older .xls files are not supported: save it as .xlsx first.');
  }
  const eocd = findEocd(buf);
  if (eocd < 0) throw reject('The file is damaged (no ZIP directory found). Save it again from Excel as .xlsx.');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) throw reject('Very large (ZIP64) workbooks are not supported.');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw reject('Very large (ZIP64) workbooks are not supported.');
  if (total > XLSX_LIMITS.maxEntries) throw reject(`The workbook has too many parts (${total}; at most ${XLSX_LIMITS.maxEntries}).`);
  if (cdOffset + cdSize > eocd) throw reject('The file is damaged (bad ZIP directory).');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw reject('The file is damaged (bad ZIP directory entry).');
    if (buf.readUInt32LE(p) === SIG_ZIP64_EOCD) throw reject('Very large (ZIP64) workbooks are not supported.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, encrypted: (flags & 1) === 1 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Throws a 400 for anything unsafe; returns the entry names when the archive looks like a workbook. */
export function assertSafeXlsx(buf: Buffer): string[] {
  if (buf.length === 0) throw reject('The file is empty.');
  if (buf.length > XLSX_LIMITS.maxFileBytes) throw new AppError(413, 'FILE_TOO_LARGE', 'The workbook is too large (maximum 2 MB).');
  const entries = readCentralDirectory(buf);
  const names = new Set<string>();
  let declaredTotal = 0;
  for (const e of entries) {
    if (e.encrypted) throw reject('Password-protected workbooks are not supported. Remove the password and save again.');
    if (e.name.includes('..') || e.name.startsWith('/') || e.name.includes('\\') || e.name.includes('\0')) throw reject('The workbook contains an unsafe file name.');
    if (/vbaProject\.bin$/i.test(e.name)) throw reject('Macro-enabled workbooks are not accepted. Save the file as a normal .xlsx workbook.');
    if (e.method !== 0 && e.method !== 8) throw reject('The workbook uses an unsupported compression method.');
    if (e.uncompressedSize > XLSX_LIMITS.maxEntryBytes) throw reject('The workbook expands to too much data (a part is larger than 10 MB).');
    declaredTotal += e.uncompressedSize;
    names.add(e.name);
  }
  if (declaredTotal > XLSX_LIMITS.maxTotalBytes) throw reject('The workbook expands to too much data (more than 25 MB).');
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw reject('This is not an Excel .xlsx workbook.');

  // Inflate every entry for real, never beyond what its header declared.
  let actualTotal = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const lh = e.localHeaderOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== SIG_LOCAL) throw reject('The file is damaged (bad ZIP entry).');
    const dataStart = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const data = buf.subarray(dataStart, dataStart + e.compressedSize);
    if (data.length !== e.compressedSize) throw reject('The file is damaged (truncated ZIP entry).');
    let size: number;
    if (e.method === 0) {
      size = data.length;
    } else {
      try {
        size = inflateRawSync(data, { maxOutputLength: Math.max(1, e.uncompressedSize) }).length;
      } catch {
        throw reject('The workbook expands to more data than it declares, or is damaged.');
      }
    }
    if (size !== e.uncompressedSize) throw reject('The workbook is damaged (a part has the wrong size).');
    actualTotal += size;
    if (actualTotal > XLSX_LIMITS.maxTotalBytes) throw reject('The workbook expands to too much data (more than 25 MB).');
  }
  return [...names];
}
