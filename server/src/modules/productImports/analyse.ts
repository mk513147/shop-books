import { normaliseMoney, toPaise } from '../../utils/money.js';
import { normaliseSearchText } from '../products/search.js';
import { cellText, type RawCell, type RawRow } from './workbook.js';

/**
 * Turns stored raw rows into proposals, issues and review groups. PURE: everything it needs from
 * the database is passed in (AnalyseContext), so it is unit-testable and re-run on every change.
 *
 * Ground rules (from the approved design):
 *  - Raw values are never modified; proposals are derived and shown next to them.
 *  - Nothing ambiguous is inferred without an explicitly confirmed batch rule or a row override:
 *    such rows are ERRORS until resolved or skipped.
 *  - Brands are matched to EXISTING brands only on an exact (case/space-insensitive) name; every
 *    other brand word needs a decision (existing brand, new brand to create, or "not a brand").
 *    Spellings are never merged automatically.
 *  - Selling prices are never calculated.
 */

export const IMPORT_FIELDS = [
  'brand',
  'name',
  'category',
  'size',
  'pages',
  'gsm',
  'binding',
  'unit',
  'packQty',
  'mrp',
  'sellingPrice',
  'purchasePrice',
  'sku',
  'barcode',
  'aliases',
  'notes',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export interface Mapping {
  /** Column letter -> field ("ignore" or absent = not imported). */
  columns: Record<string, ImportField | 'ignore'>;
  /** The user confirmed this mapping (required before commit). */
  confirmed: boolean;
}

export type SizeRule = { action: 'keep' } | { action: 'attribute'; key: string; value: string };

export interface ValueRules {
  /** "150G" / "150 GSM" (in a name or the GSM column) means GSM 150. Off until confirmed. */
  gsmSuffix: boolean;
  /** What a non-A-series size means, keyed by the upper-case value ("SL", "D", "MD"). */
  sizes: Record<string, SizeRule>;
}

export type BrandDecision =
  | { action: 'existing'; brandId: string; prefix: string }
  | { action: 'create'; name: string; prefix: string }
  | { action: 'not_brand' };

/** Row-level edits by the user; each wins over what was read. */
export interface RowOverrides {
  name?: string;
  brandId?: string | null;
  categoryId?: string;
  size?: string | null;
  pageCount?: number | null;
  gsm?: number | null;
  binding?: string | null;
  sellingUnit?: SellingUnit;
  packQty?: number;
  mrp?: string | null;
  sellingPrice?: string;
  purchasePrice?: string | null;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  attributes?: Record<string, string>;
  /** The user explicitly confirmed a selling price above the MRP for this row. */
  confirmSpAboveMrp?: boolean;
}

export type SellingUnit = 'piece' | 'pack' | 'box' | 'set' | 'ream';
export type Decision = 'pending' | 'create' | 'update' | 'skip';
export type Group = 'new' | 'update' | 'duplicate' | 'error';

export interface Issue {
  code: string;
  severity: 'error' | 'warning';
  field?: string;
  message: string;
  /** Extra data for resolving (e.g. the two prices of a "50, 3/pc" cell). */
  meta?: Record<string, unknown>;
}

export type ProposedBrand = { kind: 'existing'; id: string; name: string } | { kind: 'new'; name: string } | null;

export interface Proposal {
  name: string | null;
  brand: ProposedBrand;
  /** Brand word awaiting a decision (first word of the name / brand cell, upper case). */
  brandKey: string | null;
  categoryId: string | null;
  categoryName: string | null;
  size: string | null;
  pageCount: number | null;
  gsm: number | null;
  binding: string | null;
  sellingUnit: SellingUnit;
  packQty: number;
  attributes: Record<string, string>;
  mrp: string | null;
  sellingPrice: string | null;
  purchasePrice: string | null;
  sku: string | null;
  barcode: string | null;
  searchAliases: string[];
  description: string | null;
  confirmSpAboveMrp: boolean;
  /** Offered when the name is empty and the section names a product type (never applied automatically). */
  suggestedName: string | null;
}

export interface StoredRow {
  rowNumber: number;
  splitIndex: number;
  section: string | null;
  raw: RawRow;
  overrides: RowOverrides;
  decision: Decision;
}

export interface ExistingProduct {
  id: string;
  name: string;
  brandId: string | null;
  identity: string;
  sku: string | null;
  barcode: string | null;
}

export interface AnalyseContext {
  mapping: Mapping;
  rules: ValueRules;
  brandDecisions: Record<string, BrandDecision>;
  sectionCategories: Record<string, string>;
  brands: { id: string; name: string; isActive: boolean }[];
  categories: { id: string; name: string; isActive: boolean; isProductUsable: boolean }[];
  /** Active products, for "Update" matching. */
  products: ExistingProduct[];
}

export interface AnalysedRow {
  rowNumber: number;
  splitIndex: number;
  proposal: Proposal;
  issues: Issue[];
  group: Group;
  /** The stored user decision, or the group's default when none was chosen. */
  effectiveDecision: Decision;
  duplicateOf: number | null;
  matchedProductId: string | null;
}

// --- Small parsers ---------------------------------------------------------------------------------

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
const normKey = (s: string) => normaliseSearchText(s).toUpperCase();

/** Words of a name (normalised) start with the prefix's words. */
function startsWithWords(name: string, prefix: string): boolean {
  const n = normaliseSearchText(name);
  const p = normaliseSearchText(prefix);
  return p !== '' && (n === p || n.startsWith(`${p} `));
}

/** Removes a word prefix from the ORIGINAL text, keeping the rest exactly as written. */
function stripPrefixWords(original: string, prefix: string): string {
  const words = collapse(original).split(' ');
  const count = normaliseSearchText(prefix).split(' ').length;
  // Original words may contain punctuation that normalisation splits; fall back to a char match.
  let taken = 0;
  let consumed = 0;
  while (consumed < words.length && taken < count) {
    taken += normaliseSearchText(words[consumed]!).split(' ').filter(Boolean).length || 0;
    consumed++;
  }
  return words.slice(consumed).join(' ');
}

const MONEY_TEXT = /^\s*₹?\s*(\d{1,12})(\.\d{1,2})?\s*$/;
const MONEY_GROUPED = /^\s*₹?\s*(\d{1,3}(?:,\d{3})+)(\.\d{1,2})?\s*$/;
const DUAL_PRICE = /^\s*₹?\s*(\d{1,12}(?:\.\d{1,2})?)\s*,\s*₹?\s*(\d{1,12}(?:\.\d{1,2})?)\s*\/\s*pcs?\.?\s*$/i;
const PER_PIECE = /^\s*₹?\s*(\d{1,12}(?:\.\d{1,2})?)\s*\/\s*pcs?\.?\s*$/i;

type MoneyResult = { ok: true; value: string } | { ok: false; issue: Omit<Issue, 'field'> };

function parseMoney(cell: RawCell | undefined, label: string): MoneyResult | null {
  if (!cell) return null;
  const value = cell.t === 'f' ? cell.v : cell.v;
  if (value === null || value === '') return null;
  if (typeof value === 'number') {
    const text = String(value);
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) {
      return { ok: false, issue: { code: 'INVALID_PRICE', severity: 'error', message: `${label} “${text}” is not an amount with at most 2 decimals` } };
    }
    return { ok: true, value: normaliseMoney(text) };
  }
  if (typeof value !== 'string') {
    return { ok: false, issue: { code: 'INVALID_PRICE', severity: 'error', message: `${label} is not an amount` } };
  }
  let m = MONEY_TEXT.exec(value);
  if (m) return { ok: true, value: normaliseMoney(`${m[1]}${m[2] ?? ''}`) };
  m = MONEY_GROUPED.exec(value);
  if (m) return { ok: true, value: normaliseMoney(`${m[1]!.replace(/,/g, '')}${m[2] ?? ''}`) };
  m = DUAL_PRICE.exec(value);
  if (m) {
    return {
      ok: false,
      issue: {
        code: 'DUAL_PRICE',
        severity: 'error',
        message: `${label} “${value}” holds two prices (${m[1]} and ${m[2]} per piece). Split the row into a pack and a loose-piece product, or enter the price.`,
        meta: { packPrice: normaliseMoney(m[1]!), piecePrice: normaliseMoney(m[2]!) },
      },
    };
  }
  m = PER_PIECE.exec(value);
  if (m) {
    return {
      ok: false,
      issue: {
        code: 'PER_PIECE_PRICE',
        severity: 'error',
        message: `${label} “${value}” is a per-piece price. Confirm it as a loose-piece product (its MRP then applies to the pack), or enter the price.`,
        meta: { piecePrice: normaliseMoney(m[1]!) },
      },
    };
  }
  return { ok: false, issue: { code: 'INVALID_PRICE', severity: 'error', message: `${label} “${value}” is not an amount` } };
}

type IntResult = { ok: true; value: number } | { ok: false; issue: Omit<Issue, 'field'> };

function parseInteger(cell: RawCell | undefined, label: string, max: number, allowGSuffix = false): IntResult | null {
  if (!cell) return null;
  const value = cell.v;
  if (value === null || value === '') return null;
  let text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (allowGSuffix) text = text.replace(/\s*g(sm)?$/i, '');
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n >= 1 && n <= max) return { ok: true, value: n };
    return { ok: false, issue: { code: 'OUT_OF_RANGE', severity: 'error', message: `${label} ${text} must be between 1 and ${max}` } };
  }
  const alternatives = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(value));
  if (alternatives) {
    return {
      ok: false,
      issue: {
        code: 'ALTERNATIVE_VALUES',
        severity: 'error',
        message: `${label} “${value}” gives two values. Split the row into one product per value, or choose one.`,
        meta: { values: [Number(alternatives[1]), Number(alternatives[2])] },
      },
    };
  }
  return { ok: false, issue: { code: 'INVALID_NUMBER', severity: 'error', message: `${label} “${cellText(cell)}” is not a whole number` } };
}

const UNIT_WORDS: Record<string, SellingUnit> = {
  pc: 'piece',
  pcs: 'piece',
  piece: 'piece',
  pieces: 'piece',
  nos: 'piece',
  pack: 'pack',
  pkt: 'pack',
  packet: 'pack',
  box: 'box',
  set: 'set',
  ream: 'ream',
};

const A_SERIES = /^A(10|[0-9])$/;
const GSM_IN_TEXT = /(^|\s)(\d{2,4})\s*G(SM)?(?=\s|$)/i;

// --- Analysis ---------------------------------------------------------------------------------------

function columnFor(mapping: Mapping, field: ImportField): string | undefined {
  return Object.entries(mapping.columns).find(([, f]) => f === field)?.[0];
}

export function identityKey(p: {
  brandKey: string;
  name: string;
  size: string | null;
  pageCount: number | null;
  gsm: number | null;
  binding: string | null;
  sellingUnit: SellingUnit;
  packQty: number;
  attributes: Record<string, string | number>;
}): string {
  const attrs = Object.entries(p.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${normaliseSearchText(String(v))}`)
    .join(';');
  return [p.brandKey, normaliseSearchText(p.name), p.size ?? '', p.pageCount ?? '', p.gsm ?? '', p.binding ?? '', p.sellingUnit, p.packQty, attrs].join('|');
}

function brandIdentity(brand: ProposedBrand): string {
  if (!brand) return 'none';
  return brand.kind === 'existing' ? `id:${brand.id}` : `new:${normaliseSearchText(brand.name)}`;
}

/** First pass: read one row into a proposal plus field-tagged issues (before overrides). */
function readRow(row: StoredRow, ctx: AnalyseContext): { proposal: Proposal; issues: Issue[] } {
  const issues: Issue[] = [];
  const cell = (field: ImportField) => {
    const col = columnFor(ctx.mapping, field);
    return col ? row.raw[col] : undefined;
  };
  const text = (field: ImportField) => collapse(cellText(cell(field)));
  const add = (field: string, i: Omit<Issue, 'field'>) => issues.push({ ...i, field });

  // Name and brand.
  let name = text('name');
  let brand: ProposedBrand = null;
  let brandKey: string | null = null;
  const activeBrands = ctx.brands.filter((b) => b.isActive);
  const brandCell = text('brand');
  if (brandCell) {
    const exact = activeBrands.find((b) => normKey(b.name) === normKey(brandCell));
    if (exact) brand = { kind: 'existing', id: exact.id, name: exact.name };
    else {
      brandKey = normKey(brandCell);
      const d = ctx.brandDecisions[brandKey];
      if (!d) add('brand', { code: 'BRAND_UNDECIDED', severity: 'error', message: `“${brandCell}” is not a known brand. Decide what it is in Brands.` });
      else if (d.action === 'existing') {
        const b = ctx.brands.find((x) => x.id === d.brandId);
        brand = b ? { kind: 'existing', id: b.id, name: b.name } : null;
      } else if (d.action === 'create') brand = { kind: 'new', name: d.name };
    }
  } else if (name) {
    // Exact existing brand at the start of the name (longest wins).
    const exact = activeBrands
      .filter((b) => startsWithWords(name, b.name))
      .sort((a, b) => normaliseSearchText(b.name).length - normaliseSearchText(a.name).length)[0];
    const firstWord = normKey(name).split(' ')[0] ?? '';
    const decision = ctx.brandDecisions[firstWord];
    if (decision) {
      brandKey = firstWord;
      if (decision.action === 'not_brand') brand = null;
      else if (!startsWithWords(name, decision.prefix)) {
        add('brand', {
          code: 'BRAND_PREFIX_MISMATCH',
          severity: 'error',
          message: `The name does not start with “${decision.prefix}”, the brand words chosen for “${firstWord}”.`,
        });
      } else {
        if (decision.action === 'existing') {
          const b = ctx.brands.find((x) => x.id === decision.brandId);
          brand = b ? { kind: 'existing', id: b.id, name: b.name } : null;
        } else brand = { kind: 'new', name: decision.name };
        name = stripPrefixWords(name, decision.prefix);
      }
    } else if (exact) {
      brand = { kind: 'existing', id: exact.id, name: exact.name };
      name = stripPrefixWords(name, exact.name);
    } else if (firstWord) {
      brandKey = firstWord;
      add('brand', {
        code: 'BRAND_UNDECIDED',
        severity: 'error',
        message: `Is “${firstWord}” a brand? Decide in Brands (existing brand, new brand, or not a brand).`,
      });
    }
  }

  // GSM inside the name ("DOMS SPIRAL 150G") only with the confirmed rule.
  let gsmFromName: number | null = null;
  const gsmMatch = GSM_IN_TEXT.exec(name);
  if (gsmMatch) {
    if (ctx.rules.gsmSuffix) {
      gsmFromName = Number(gsmMatch[2]);
      name = collapse(name.replace(GSM_IN_TEXT, ' '));
    } else {
      add('gsm', {
        code: 'GSM_IN_NAME',
        severity: 'warning',
        message: `The name contains “${collapse(gsmMatch[0])}”. Turn on the rule “numbers followed by G are GSM” to store it as GSM; otherwise it stays in the name.`,
      });
    }
  }

  let suggestedName: string | null = null;
  if (!name) {
    const sectionIsBrand = row.section !== null && brand !== null && normKey(row.section) === normKey(brand.name);
    if (row.section && !sectionIsBrand && normKey(row.section) !== brandKey) suggestedName = row.section;
    add('name', {
      code: 'NAME_REQUIRED',
      severity: 'error',
      message: suggestedName
        ? `Only a brand is given. Enter a product name (suggestion: “${suggestedName}”, from the section).`
        : 'Only a brand is given. Enter a product name (e.g. what kind of product it is).',
    });
  }

  // Category: category column, else the section's chosen category.
  let categoryId: string | null = null;
  let categoryName: string | null = null;
  const usable = ctx.categories.filter((c) => c.isActive && c.isProductUsable);
  const categoryCell = text('category');
  if (categoryCell) {
    const match = usable.find((c) => c.name.toLowerCase() === categoryCell.toLowerCase());
    if (match) {
      categoryId = match.id;
      categoryName = match.name;
    } else {
      add('category', {
        code: 'CATEGORY_UNKNOWN',
        severity: 'error',
        message: `“${categoryCell}” is not a category marked for products. Mark it on the Categories page or choose a category for the row.`,
      });
    }
  } else if (row.section && ctx.sectionCategories[row.section]) {
    const match = usable.find((c) => c.id === ctx.sectionCategories[row.section!]);
    if (match) {
      categoryId = match.id;
      categoryName = match.name;
    } else add('category', { code: 'CATEGORY_UNUSABLE', severity: 'error', message: 'The category chosen for this section is no longer available for products.' });
  } else {
    add('category', { code: 'CATEGORY_REQUIRED', severity: 'error', message: row.section ? `Choose a category for section “${row.section}”.` : 'Choose a category.' });
  }

  // Size.
  let size: string | null = null;
  const attributes: Record<string, string> = {};
  const sizeText = text('size').toUpperCase();
  if (sizeText) {
    if (A_SERIES.test(sizeText)) size = sizeText;
    else {
      const rule = ctx.rules.sizes[sizeText];
      if (!rule) {
        add('size', {
          code: 'AMBIGUOUS_SIZE',
          severity: 'error',
          message: `What does size “${sizeText}” mean? Set a rule for it (keep as a size, or store it as another detail such as ruling).`,
          meta: { value: sizeText },
        });
      } else if (rule.action === 'keep') size = sizeText.slice(0, 20);
      else attributes[rule.key] = rule.value;
    }
  }

  const pages = parseInteger(cell('pages'), 'Pages', 10_000);
  const pageCount = pages?.ok ? pages.value : null;
  if (pages && !pages.ok) add('pageCount', pages.issue);

  let gsm: number | null = gsmFromName;
  const gsmCell = parseInteger(cell('gsm'), 'GSM', 2000, true);
  if (gsmCell?.ok) gsm = gsmCell.value;
  else if (gsmCell) add('gsm', gsmCell.issue);

  const bindingText = text('binding').toLowerCase();
  const binding = bindingText ? bindingText.slice(0, 40) : null;

  let sellingUnit: SellingUnit = 'piece';
  const unitText = text('unit').toLowerCase();
  if (unitText) {
    const u = UNIT_WORDS[unitText];
    if (u) sellingUnit = u;
    else add('sellingUnit', { code: 'INVALID_UNIT', severity: 'error', message: `Unit “${unitText}” is not one of piece, pack, box, set or ream.` });
  }
  let packQty = 1;
  const pack = parseInteger(cell('packQty'), 'Pack quantity', 100_000);
  if (pack?.ok) packQty = pack.value;
  else if (pack) add('packQty', pack.issue);

  const money = (field: ImportField, key: string, label: string): string | null => {
    const r = parseMoney(cell(field), label);
    if (!r) return null;
    if (r.ok) return r.value;
    add(key, r.issue);
    return null;
  };
  const sellingPrice = money('sellingPrice', 'sellingPrice', 'Selling price');
  const mrp = money('mrp', 'mrp', 'MRP');
  const purchasePrice = money('purchasePrice', 'purchasePrice', 'Purchase price');

  const sku = text('sku') || null;
  const barcode = text('barcode') || null;
  const aliasText = text('aliases');
  const searchAliases = aliasText
    ? [...new Set(aliasText.split(/[,;]/).map((a) => collapse(a).toLowerCase()).filter(Boolean))].slice(0, 20)
    : [];
  const description = text('notes') || null;

  return {
    proposal: {
      name: name || null,
      brand,
      brandKey,
      categoryId,
      categoryName,
      size,
      pageCount,
      gsm,
      binding,
      sellingUnit,
      packQty,
      attributes,
      mrp,
      sellingPrice,
      purchasePrice,
      sku,
      barcode,
      searchAliases,
      description,
      confirmSpAboveMrp: false,
      suggestedName,
    },
    issues,
  };
}

/** Second pass: apply overrides (they replace a field and its read issues), then validate the result. */
function finalise(read: { proposal: Proposal; issues: Issue[] }, o: RowOverrides, ctx: AnalyseContext): { proposal: Proposal; issues: Issue[] } {
  const p: Proposal = { ...read.proposal, attributes: { ...read.proposal.attributes } };
  const overridden = new Set<string>();
  const set = <K extends keyof Proposal>(key: K, value: Proposal[K], field: string = key) => {
    p[key] = value;
    overridden.add(field);
  };
  if (o.name !== undefined) set('name', collapse(o.name) || null);
  if (o.brandId !== undefined) {
    if (o.brandId === null) set('brand', null);
    else {
      const b = ctx.brands.find((x) => x.id === o.brandId);
      set('brand', b ? { kind: 'existing', id: b.id, name: b.name } : null);
    }
  }
  if (o.categoryId !== undefined) {
    const c = ctx.categories.find((x) => x.id === o.categoryId);
    p.categoryId = c?.id ?? null;
    p.categoryName = c?.name ?? null;
    overridden.add('category');
  }
  if (o.size !== undefined) set('size', o.size ? collapse(o.size).toUpperCase() : null);
  if (o.pageCount !== undefined) set('pageCount', o.pageCount);
  if (o.gsm !== undefined) set('gsm', o.gsm);
  if (o.binding !== undefined) set('binding', o.binding ? collapse(o.binding).toLowerCase() : null);
  if (o.sellingUnit !== undefined) set('sellingUnit', o.sellingUnit);
  if (o.packQty !== undefined) set('packQty', o.packQty);
  if (o.mrp !== undefined) set('mrp', o.mrp);
  if (o.sellingPrice !== undefined) set('sellingPrice', o.sellingPrice);
  if (o.purchasePrice !== undefined) set('purchasePrice', o.purchasePrice);
  if (o.sku !== undefined) set('sku', o.sku);
  if (o.barcode !== undefined) set('barcode', o.barcode);
  if (o.description !== undefined) set('description', o.description);
  if (o.attributes !== undefined) {
    p.attributes = { ...p.attributes, ...o.attributes };
    overridden.add('size');
  }
  if (o.confirmSpAboveMrp !== undefined) p.confirmSpAboveMrp = o.confirmSpAboveMrp;

  const issues = read.issues.filter((i) => !i.field || !overridden.has(i.field));
  const add = (i: Issue) => issues.push(i);

  if (!p.name && !issues.some((i) => i.code === 'NAME_REQUIRED')) {
    add({ code: 'NAME_REQUIRED', severity: 'error', field: 'name', message: 'Enter a product name.' });
  }
  if (p.name && p.name.length > 160) add({ code: 'NAME_TOO_LONG', severity: 'error', field: 'name', message: 'The name is longer than 160 characters.' });
  if (overridden.has('category') && !p.categoryId) add({ code: 'CATEGORY_REQUIRED', severity: 'error', field: 'category', message: 'Choose a category.' });
  if (overridden.has('category') && p.categoryId) {
    const c = ctx.categories.find((x) => x.id === p.categoryId);
    if (!c || !c.isActive || !c.isProductUsable) {
      add({ code: 'CATEGORY_UNUSABLE', severity: 'error', field: 'category', message: 'This category is not available for products.' });
    }
  }
  if (p.sellingPrice === null) {
    if (!issues.some((i) => i.field === 'sellingPrice')) {
      add({ code: 'SELLING_PRICE_REQUIRED', severity: 'error', field: 'sellingPrice', message: 'The selling price is missing.' });
    }
  } else if (toPaise(p.sellingPrice) === 0n) {
    add({ code: 'SELLING_PRICE_ZERO', severity: 'error', field: 'sellingPrice', message: 'The selling price is 0. Enter the price.' });
  }
  if (p.mrp !== null && toPaise(p.mrp) === 0n) {
    add({
      code: 'MRP_ZERO',
      severity: 'error',
      field: 'mrp',
      message: 'The MRP is 0. Choose “no MRP” or enter the printed MRP.',
    });
  }
  if (p.sellingPrice !== null && p.mrp !== null && toPaise(p.mrp) > 0n && toPaise(p.sellingPrice) > 0n) {
    if (toPaise(p.sellingPrice) > toPaise(p.mrp) && !p.confirmSpAboveMrp) {
      add({
        code: 'SP_ABOVE_MRP',
        severity: 'error',
        field: 'confirmSpAboveMrp',
        message: `The selling price ₹${p.sellingPrice} is above the MRP ₹${p.mrp}. Confirm it explicitly or correct a price.`,
      });
    }
    if (toPaise(p.sellingPrice) * 2n < toPaise(p.mrp)) {
      add({
        code: 'DEEP_DISCOUNT',
        severity: 'warning',
        field: 'sellingPrice',
        message: `The selling price ₹${p.sellingPrice} is less than half the MRP ₹${p.mrp}. Check it is not a typing mistake.`,
      });
    }
  }
  if (p.purchasePrice !== null && p.sellingPrice !== null && toPaise(p.purchasePrice) > toPaise(p.sellingPrice)) {
    add({ code: 'PURCHASE_ABOVE_SELLING_PRICE', severity: 'warning', field: 'purchasePrice', message: 'The purchase price is above the selling price.' });
  }
  if (p.sellingUnit === 'piece' && p.packQty !== 1) {
    add({ code: 'PACK_QTY_FOR_PIECE', severity: 'error', field: 'packQty', message: 'A product sold by the piece has a pack quantity of 1.' });
  }
  if (p.sku !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/.test(p.sku)) {
    add({ code: 'INVALID_SKU', severity: 'error', field: 'sku', message: 'SKU: 1–40 letters, digits, ".", "_", "/" or "-".' });
  }
  if (p.barcode !== null && !/^[A-Za-z0-9-]{4,64}$/.test(p.barcode)) {
    add({ code: 'INVALID_BARCODE', severity: 'error', field: 'barcode', message: 'Barcode: 4–64 letters, digits or "-".' });
  }
  if (p.description !== null && p.description.length > 1000) {
    add({ code: 'DESCRIPTION_TOO_LONG', severity: 'error', field: 'description', message: 'Notes are longer than 1000 characters.' });
  }
  if (p.size !== null && p.size.length > 20) add({ code: 'SIZE_TOO_LONG', severity: 'error', field: 'size', message: 'The size is longer than 20 characters.' });
  if (p.brand?.kind === 'existing' && !ctx.brands.find((b) => b.id === (p.brand as { id: string }).id)?.isActive) {
    add({ code: 'BRAND_ARCHIVED', severity: 'error', field: 'brand', message: `The brand “${p.brand.name}” is archived.` });
  }
  return { proposal: p, issues };
}

const DEFAULT_DECISION: Record<Group, Decision> = { new: 'create', update: 'pending', duplicate: 'skip', error: 'pending' };

/** Rows in a stable order: by sheet row, then split. */
const byPosition = (a: { rowNumber: number; splitIndex: number }, b: { rowNumber: number; splitIndex: number }) =>
  a.rowNumber - b.rowNumber || a.splitIndex - b.splitIndex;

export function analyseRows(rows: StoredRow[], ctx: AnalyseContext): AnalysedRow[] {
  const sorted = [...rows].sort(byPosition);
  const results = sorted.map((row) => {
    const read = readRow(row, ctx);
    const { proposal, issues } = finalise(read, row.overrides, ctx);
    return { row, proposal, issues };
  });

  // Existing-product matches (active products), by identity or by code.
  const byIdentity = new Map<string, ExistingProduct>();
  const byCode = new Map<string, ExistingProduct>();
  for (const prod of ctx.products) {
    byIdentity.set(prod.identity, prod);
    if (prod.sku) byCode.set(`sku:${prod.sku.toLowerCase()}`, prod);
    if (prod.barcode) byCode.set(`bc:${prod.barcode}`, prod);
  }

  // Within-file duplicates and conflicts (rows the user skipped take no part).
  const firstExact = new Map<string, number>();
  const firstIdentity = new Map<string, { index: number; prices: string }>();
  const out: AnalysedRow[] = [];
  results.forEach(({ row, proposal, issues }, index) => {
    let duplicateOf: number | null = null;
    let matched: ExistingProduct | null = null;
    const skipped = row.decision === 'skip';
    const identity =
      proposal.name !== null
        ? identityKey({
            brandKey: brandIdentity(proposal.brand),
            name: proposal.name,
            size: proposal.size,
            pageCount: proposal.pageCount,
            gsm: proposal.gsm,
            binding: proposal.binding,
            sellingUnit: proposal.sellingUnit,
            packQty: proposal.packQty,
            attributes: proposal.attributes,
          })
        : null;

    if (!skipped) {
      // Exactly the same source row (same section, same cells): a copy.
      const exact = JSON.stringify([row.section, Object.entries(row.raw).sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => [k, cellText(c).trim()]), row.overrides]);
      const seen = firstExact.get(exact);
      if (seen !== undefined && row.splitIndex === 0) duplicateOf = seen;
      else firstExact.set(exact, row.rowNumber);

      if (identity && duplicateOf === null) {
        const prices = JSON.stringify([proposal.mrp, proposal.sellingPrice, proposal.purchasePrice]);
        const prior = firstIdentity.get(identity);
        if (!prior) firstIdentity.set(identity, { index, prices });
        else if (prior.prices === prices) duplicateOf = results[prior.index]!.row.rowNumber;
        else {
          const conflict: Issue = {
            code: 'PRICE_CONFLICT',
            severity: 'error',
            message: 'Another row describes the same product with different prices. Make the products distinguishable (e.g. edit the name) or skip one row.',
          };
          issues.push({ ...conflict, meta: { otherRow: results[prior.index]!.row.rowNumber } });
          const other = out[prior.index];
          if (other && !other.issues.some((i) => i.code === 'PRICE_CONFLICT')) {
            other.issues.push({ ...conflict, meta: { otherRow: row.rowNumber } });
            if (other.group !== 'error') {
              other.group = 'error';
              other.effectiveDecision = results[prior.index]!.row.decision === 'pending' ? 'pending' : other.effectiveDecision;
            }
          }
        }
      }
      // A brand that does not exist yet cannot have products, so only existing/no-brand rows match.
      if (identity && proposal.brand?.kind !== 'new') matched = byIdentity.get(identity) ?? null;
      if (!matched && proposal.sku) matched = byCode.get(`sku:${proposal.sku.toLowerCase()}`) ?? null;
      if (!matched && proposal.barcode) matched = byCode.get(`bc:${proposal.barcode}`) ?? null;
    }

    const hasError = issues.some((i) => i.severity === 'error');
    const group: Group = hasError ? 'error' : duplicateOf !== null ? 'duplicate' : matched ? 'update' : 'new';
    let effective: Decision = row.decision === 'pending' ? DEFAULT_DECISION[group] : row.decision;
    if (effective === 'update' && !matched) effective = 'pending';
    out.push({
      rowNumber: row.rowNumber,
      splitIndex: row.splitIndex,
      proposal,
      issues,
      group,
      effectiveDecision: effective,
      duplicateOf,
      matchedProductId: matched?.id ?? null,
    });
  });
  return out;
}

export interface BrandCandidate {
  key: string;
  rows: number;
  examples: string[];
  decision: BrandDecision | null;
  /** Other undecided words in this file that look alike (e.g. PAPERKARFT / PAPERKART). Never merged automatically. */
  similarInFile: string[];
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

/** Brand words that need (or have) a decision, with examples. */
export function brandCandidates(rows: StoredRow[], analysed: AnalysedRow[], ctx: AnalyseContext): BrandCandidate[] {
  const byKey = new Map<string, { rows: number; examples: string[] }>();
  analysed.forEach((a) => {
    const key = a.proposal.brandKey;
    if (!key) return;
    const source = rows.find((r) => r.rowNumber === a.rowNumber && r.splitIndex === a.splitIndex);
    const nameCol = columnFor(ctx.mapping, 'name');
    const brandCol = columnFor(ctx.mapping, 'brand');
    const example = collapse(cellText(source?.raw[brandCol ?? nameCol ?? ''] ?? source?.raw[nameCol ?? '']));
    const entry = byKey.get(key) ?? { rows: 0, examples: [] };
    entry.rows++;
    if (example && !entry.examples.includes(example) && entry.examples.length < 4) entry.examples.push(example);
    byKey.set(key, entry);
  });
  const keys = [...byKey.keys()].sort();
  return keys.map((key) => ({
    key,
    rows: byKey.get(key)!.rows,
    examples: byKey.get(key)!.examples,
    decision: ctx.brandDecisions[key] ?? null,
    similarInFile: keys.filter((k) => k !== key && key.length >= 4 && editDistance(k, key) <= 2),
  }));
}

/** Can the batch be committed? Returns the reasons it cannot. */
export function commitBlockers(analysed: AnalysedRow[], mapping: Mapping): string[] {
  const blockers: string[] = [];
  if (!mapping.confirmed) blockers.push('Confirm the column mapping.');
  if (!Object.values(mapping.columns).includes('name')) blockers.push('Map a column to the product name.');
  if (!Object.values(mapping.columns).includes('sellingPrice')) blockers.push('Map a column to the selling price.');
  const pending = analysed.filter((a) => a.effectiveDecision === 'pending').length;
  if (pending) blockers.push(`${pending} row${pending === 1 ? '' : 's'} still need a decision (fix the errors, choose update or skip).`);
  const errorRows = analysed.filter((a) => a.effectiveDecision !== 'skip' && a.issues.some((i) => i.severity === 'error')).length;
  if (errorRows) blockers.push(`${errorRows} row${errorRows === 1 ? '' : 's'} to import still have errors.`);
  if (!analysed.some((a) => a.effectiveDecision === 'create' || a.effectiveDecision === 'update')) blockers.push('No rows are selected for import.');
  return blockers;
}

/** Splits a value like "Sl  " into what is stored for sections and keys. */
export const sectionLabel = (text: string) => collapse(text);
