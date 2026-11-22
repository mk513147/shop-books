import { CheckCircle2, Download, FileSpreadsheet, Scissors, Undo2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/search-select';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useBrands } from '@/features/brands/brands-api';
import { useCategories } from '@/features/categories/categories-api';
import {
  checkImportFile,
  createImportBatch,
  downloadImportReport,
  FIELD_LABELS,
  IMPORT_FIELDS,
  importErrorMessage,
  inspectWorkbook,
  useCommitImport,
  useDiscardImport,
  useImportBatch,
  useImportBatches,
  useImportRows,
  useSplitImportRow,
  useUnsplitImportRow,
  useUpdateImportRows,
  useUpdateImportSettings,
  type BrandCandidate,
  type BrandDecision,
  type Decision,
  type Group,
  type ImportBatch,
  type ImportField,
  type ImportRow,
  type RowOverrides,
  type SellingUnit,
  type SheetPreview,
  type SizeRule,
} from '@/features/productImports/imports-api';
import { formatDateTime } from '@/lib/dates';
import { formatInr, MONEY_INPUT } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PHONE_MEDIA_QUERY } from '@/lib/visual-viewport';

// --- Shared helpers ----------------------------------------------------------------------------------

/** True below the md breakpoint (phones). */
export function useIsPhone(): boolean {
  const query = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_MEDIA_QUERY).matches;
  const [phone, setPhone] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(PHONE_MEDIA_QUERY);
    const onChange = () => setPhone(mql.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);
  return phone;
}

const PHONE_MESSAGE = 'Importing is easier on a computer or tablet. Open this page on a larger screen.';

const columnLetter = (index: number) => {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

const sortLetters = (letters: string[]) => [...letters].sort((a, b) => a.length - b.length || a.localeCompare(b));

/** Raw cell text exactly as read; leading/trailing spaces are made visible. */
function RawValue({ value }: { value: string | undefined }) {
  if (value === undefined || value === '') return <span className="text-muted-foreground">—</span>;
  if (value !== value.trim()) {
    return (
      <span title="This cell has spaces at the start or end">
        “{value.replace(/ /g, ' ')}”<span className="sr-only"> (with extra spaces)</span>
      </span>
    );
  }
  return <>{value}</>;
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const STATUS_TONE = { review: 'warning', committed: 'accent', discarded: 'neutral' } as const;
const STATUS_LABEL = { review: 'In review', committed: 'Imported', discarded: 'Discarded' } as const;

function ImportList() {
  const batches = useImportBatches();
  if (batches.isPending) return <LoadingState label="Loading imports…" />;
  if (batches.isError) return <p className="callout callout-danger">{importErrorMessage(batches.error)}</p>;
  if (batches.data.length === 0) return <p className="text-sm text-muted-foreground">No imports yet.</p>;
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {batches.data.map((b) => (
        <li key={b.id}>
          <Link to={`/products/import/${b.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted">
            <span className="min-w-0">
              <span className="block truncate font-medium">
                {b.fileName} · {b.sheetName}
              </span>
              <span className="text-xs text-muted-foreground">
                {b.rows} rows · {formatDateTime(b.createdAt)} by {b.createdBy}
              </span>
            </span>
            <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// --- /products/import -----------------------------------------------------------------------------------

export function ProductImportPage() {
  const navigate = useNavigate();
  const phone = useIsPhone();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'inspect' | 'create' | null>(null);
  const [sheets, setSheets] = useState<SheetPreview[] | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [range, setRange] = useState('');
  const [headerRow, setHeaderRow] = useState('1');
  const [sectionRows, setSectionRows] = useState(true);
  const sheet = sheets?.find((s) => s.name === sheetName) ?? null;

  function chooseSheet(s: SheetPreview) {
    setSheetName(s.name);
    const block = s.blocks.find((b) => !b.duplicateOf) ?? s.blocks[0];
    setRange(block?.range ?? '');
    // Suggest the first row of the block that holds more than one distinct value as the header.
    const firstRow = Number(/\d+/.exec(block?.range ?? '')?.[0] ?? 1);
    const headerGuess = s.preview.find((r) => r.row >= firstRow && new Set(r.cells.filter(Boolean)).size > 1);
    setHeaderRow(String(headerGuess?.row ?? firstRow));
  }

  async function inspect(chosen: File) {
    const problem = checkImportFile(chosen);
    setSheets(null);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(chosen);
    setError(null);
    setBusy('inspect');
    try {
      const result = await inspectWorkbook(chosen);
      setSheets(result.sheets);
      if (result.sheets[0]) chooseSheet(result.sheets[0]);
    } catch (err) {
      setError(importErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!file || !sheet) return;
    const row = Number(headerRow);
    if (!/^[A-Za-z]{1,3}\d+:[A-Za-z]{1,3}\d+$/.test(range.trim()) || !Number.isInteger(row) || row < 1) {
      setError('Enter the block as a range like A1:E109 and the header row as a number.');
      return;
    }
    setBusy('create');
    setError(null);
    try {
      const { batch } = await createImportBatch(file, { sheet: sheet.name, range: range.trim().toUpperCase(), headerRow: row, sectionRows });
      toast({ title: 'Workbook read', description: `${batch.counts.total} rows ready for review`, tone: 'success' });
      navigate(`/products/import/${batch.id}`);
    } catch (err) {
      setError(importErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const width = sheet ? Math.min(Math.max(...sheet.preview.map((r) => r.cells.length), 0), 30) : 0;

  return (
    <Page>
      <PageHeader
        back={{ to: '/products', label: 'Products' }}
        title="Import products from Excel"
        description="Upload an .xlsx workbook, choose the table to read, then review every row before anything is saved."
      />

      {phone ? (
        <p className="callout callout-info">{PHONE_MESSAGE}</p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>1. Choose the workbook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex">
                <span className="sr-only">Excel workbook (.xlsx)</span>
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  aria-label="Excel workbook (.xlsx)"
                  className="text-sm file:mr-3 file:rounded-lg file:border file:bg-card file:px-3 file:py-2 file:text-sm file:font-medium"
                  onChange={(e) => {
                    const chosen = e.target.files?.[0];
                    e.target.value = '';
                    if (chosen) void inspect(chosen);
                  }}
                />
              </label>
              {busy === 'inspect' && <span className="text-sm text-muted-foreground">Reading the workbook…</span>}
              {file && sheets && (
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                  <FileSpreadsheet className="size-4" aria-hidden="true" /> {file.name}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Only .xlsx files up to 2 MB. Nothing is saved until you choose the sheet and the table.</p>
            {error && (
              <p role="alert" className="callout callout-danger">
                {error}
              </p>
            )}

            {sheets && (
              <div className="space-y-4 border-t pt-4">
                <h3 className="font-semibold">2. Choose the sheet and the table</h3>
                <Field id="import-sheet" label="Sheet">
                  <Select
                    id="import-sheet"
                    value={sheetName}
                    onChange={(e) => {
                      const next = sheets.find((s) => s.name === e.target.value);
                      if (next) chooseSheet(next);
                    }}
                  >
                    {sheets.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {sheet && (
                  <>
                    {sheet.blocks.length > 0 && (
                      <div className="space-y-1 text-sm">
                        <p className="font-medium">Tables found on this sheet</p>
                        <ul className="space-y-1">
                          {sheet.blocks.map((b) => (
                            <li key={b.range} className={cn(b.duplicateOf && 'callout callout-warning')}>
                              {b.duplicateOf ? (
                                <span>
                                  {b.range} repeats {b.duplicateOf} — import one of them only.
                                </span>
                              ) : (
                                <button type="button" className="font-medium text-primary underline" onClick={() => setRange(b.range)}>
                                  {b.range}
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="table-shell max-h-96 overflow-auto">
                      <table className="data-table text-xs" aria-label={`Preview of ${sheet.name}`}>
                        <thead>
                          <tr>
                            <th className="px-2 py-1">#</th>
                            {Array.from({ length: width }, (_, i) => (
                              <th key={i} className="px-2 py-1">
                                {columnLetter(i)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sheet.preview.map((r) => (
                            <tr key={r.row} className={cn(String(r.row) === headerRow && 'bg-primary-soft font-semibold')}>
                              <td className="px-2 py-1 text-muted-foreground">{r.row}</td>
                              {Array.from({ length: width }, (_, i) => (
                                <td key={i} className="max-w-40 truncate px-2 py-1">
                                  {r.cells[i] ? <RawValue value={r.cells[i]} /> : ''}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="grid gap-4 md:grid-cols-3">
                      <Field id="import-range" label="Table (range)" hint="Columns and rows, e.g. A1:E109">
                        <Input id="import-range" value={range} onChange={(e) => setRange(e.target.value)} autoComplete="off" />
                      </Field>
                      <Field id="import-header" label="Header row" hint="The row with the column titles">
                        <Input id="import-header" inputMode="numeric" value={headerRow} onChange={(e) => setHeaderRow(e.target.value)} />
                      </Field>
                      <label className="flex items-start gap-2 pt-7 text-sm">
                        <input type="checkbox" className="mt-0.5 size-4" checked={sectionRows} onChange={(e) => setSectionRows(e.target.checked)} />
                        Rows whose cells all repeat one label are section titles
                      </label>
                    </div>
                    <Button loading={busy === 'create'} onClick={() => void create()}>
                      <Upload aria-hidden="true" /> {busy === 'create' ? 'Reading rows…' : 'Read this table'}
                    </Button>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">Recent imports</h2>
        <ImportList />
      </section>
    </Page>
  );
}

// --- /products/import/:id -------------------------------------------------------------------------------

const GROUPS: { value: Group; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'update', label: 'Update' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'error', label: 'Error' },
];

const DECISION_LABEL: Record<Decision, string> = { create: 'Create', update: 'Update prices', skip: 'Skip', pending: 'Decide later' };

export function ProductImportBatchPage() {
  const { id = '' } = useParams();
  const phone = useIsPhone();
  const batch = useImportBatch(id);

  if (batch.isPending) return <LoadingState label="Loading the import…" skeleton="detail" />;
  if (batch.isError) return <ErrorState title="Could not load this import" error={new Error(importErrorMessage(batch.error))} />;
  const b = batch.data;

  return (
    <Page>
      <PageHeader
        back={{ to: '/products/import', label: 'Imports' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {b.fileName}
            <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge>
          </span>
        }
        description={`Sheet “${b.sheetName}”, table ${b.blockRange}, header row ${b.headerRow}`}
      />
      {phone ? (
        <p className="callout callout-info">{PHONE_MESSAGE}</p>
      ) : (
        <>
          <SummaryCard batch={b} />
          {b.status === 'review' && (
            <>
              <MappingCard batch={b} />
              <RulesCard batch={b} />
              <BrandsCard batch={b} />
              <SectionsCard batch={b} />
            </>
          )}
          <RowsCard batch={b} />
        </>
      )}
    </Page>
  );
}

function useFeedback() {
  const toast = useToast();
  return (title: string) => (err: unknown) => toast({ title, description: importErrorMessage(err), tone: 'error' });
}

function SummaryCard({ batch }: { batch: ImportBatch }) {
  const commit = useCommitImport(batch.id);
  const discard = useDiscardImport(batch.id);
  const toast = useToast();
  const fail = useFeedback();
  const [dialog, setDialog] = useState<'commit' | 'discard' | null>(null);
  const [downloading, setDownloading] = useState(false);
  const c = batch.counts;
  const blocked = batch.blockers.length > 0;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Summary</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            loading={downloading}
            onClick={async () => {
              setDownloading(true);
              try {
                await downloadImportReport(batch.id);
              } catch (err) {
                fail('Could not download the report')(err);
              } finally {
                setDownloading(false);
              }
            }}
          >
            <Download aria-hidden="true" /> Review report
          </Button>
          {batch.status === 'review' && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setDialog('discard')}>
                Discard
              </Button>
              <Button size="sm" disabled={blocked} onClick={() => setDialog('commit')}>
                <CheckCircle2 aria-hidden="true" /> Import products
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {GROUPS.map((g) => (
            <div key={g.value}>
              <dt className="text-xs text-muted-foreground">{g.label}</dt>
              <dd className="figure text-lg font-semibold">{c[g.value]}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground">
          To create: {c.toCreate} · to update: {c.toUpdate} · to skip: {c.toSkip} · undecided: {c.pending}
          {batch.skippedRows.length > 0 && ` · ${batch.skippedRows.length} header/section rows left out`}
        </p>
        {batch.result && (
          <p className="callout callout-success">
            Imported: {batch.result.created} created, {batch.result.updated} updated, {batch.result.skipped} skipped, {batch.result.brandsCreated} new brands.
          </p>
        )}
        {batch.status === 'review' && blocked && (
          <div className="callout callout-warning" data-testid="import-blockers">
            <p className="font-medium">Before importing:</p>
            <ul className="list-disc pl-5">
              {batch.blockers.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      <Dialog
        open={dialog === 'commit'}
        title="Import these products?"
        onClose={() => setDialog(null)}
        dismissible={!commit.isPending}
        size="sm"
        footer={
          <DialogActions>
            <Button variant="outline" disabled={commit.isPending} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              loading={commit.isPending}
              onClick={() =>
                commit.mutate(
                  { version: batch.version },
                  {
                    onSuccess: ({ batch: done }) => {
                      setDialog(null);
                      toast({ title: 'Products imported', description: `${done.result?.created ?? 0} created, ${done.result?.updated ?? 0} updated`, tone: 'success' });
                    },
                    onError: (err) => {
                      setDialog(null);
                      fail('Nothing was imported')(err);
                    },
                  },
                )
              }
            >
              {commit.isPending ? 'Importing…' : 'Import'}
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">
          {c.toCreate} products will be created, {c.toUpdate} existing products will get the new prices, and {c.toSkip} rows will be skipped. Everything is saved
          together: if anything fails, nothing is saved.
        </p>
      </Dialog>
      <Dialog
        open={dialog === 'discard'}
        title="Discard this import?"
        onClose={() => setDialog(null)}
        size="sm"
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              loading={discard.isPending}
              onClick={() =>
                discard.mutate({ version: batch.version }, { onSuccess: () => setDialog(null), onError: (err) => fail('Could not discard')(err) })
              }
            >
              Discard
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">No products will be created from it. The rows stay in the import history.</p>
      </Dialog>
    </Card>
  );
}

function MappingCard({ batch }: { batch: ImportBatch }) {
  const update = useUpdateImportSettings(batch.id);
  const fail = useFeedback();
  const letters = sortLetters(Object.keys(batch.header));
  const [columns, setColumns] = useState(batch.mapping.columns);
  useEffect(() => setColumns(batch.mapping.columns), [batch.mapping.columns]);
  const changed = JSON.stringify(columns) !== JSON.stringify(batch.mapping.columns);
  const used = Object.values(columns).filter((f) => f !== 'ignore');
  const duplicate = used.find((f, i) => used.indexOf(f) !== i);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Columns</CardTitle>
        {batch.mapping.confirmed && !changed ? <Badge tone="accent">Confirmed</Badge> : <Badge tone="warning">Not confirmed</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Say what each column holds. Abbreviations such as “SP” are never guessed: choose the field yourself.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {letters.map((letter) => (
            <Field key={letter} id={`map-${letter}`} label={`${letter}: “${batch.header[letter] ?? ''}”`}>
              <Select
                id={`map-${letter}`}
                value={columns[letter] ?? 'ignore'}
                onChange={(e) => setColumns({ ...columns, [letter]: e.target.value as ImportField | 'ignore' })}
              >
                <option value="ignore">Don’t import</option>
                {IMPORT_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {FIELD_LABELS[f]}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        {duplicate && (
          <p role="alert" className="callout callout-danger">
            “{FIELD_LABELS[duplicate as ImportField]}” is chosen for more than one column.
          </p>
        )}
        <Button
          loading={update.isPending}
          disabled={Boolean(duplicate) || (batch.mapping.confirmed && !changed)}
          onClick={() => update.mutate({ version: batch.version, mapping: { columns, confirmed: true } }, { onError: fail('Could not save the columns') })}
        >
          Confirm columns
        </Button>
      </CardContent>
    </Card>
  );
}

function SizeRuleRow({ batch, value, rows, rule }: { batch: ImportBatch; value: string; rows: number; rule: SizeRule | null }) {
  const update = useUpdateImportSettings(batch.id);
  const fail = useFeedback();
  const [mode, setMode] = useState<'' | 'keep' | 'attribute'>(rule?.action ?? '');
  const [key, setKey] = useState(rule?.action === 'attribute' ? rule.key : 'ruling');
  const [val, setVal] = useState(rule?.action === 'attribute' ? rule.value : '');

  function save() {
    const sizes = { ...batch.valueRules.sizes };
    if (mode === '') delete sizes[value];
    else if (mode === 'keep') sizes[value] = { action: 'keep' };
    else sizes[value] = { action: 'attribute', key: key.trim().toLowerCase().replace(/\s+/g, '_'), value: val.trim() };
    update.mutate({ version: batch.version, valueRules: { ...batch.valueRules, sizes } }, { onError: fail('Could not save the rule') });
  }

  return (
    <div className="grid items-end gap-2 md:grid-cols-[8rem_1fr_1fr_1fr_auto]">
      <p className="text-sm">
        <span className="font-semibold">“{value}”</span> <span className="text-muted-foreground">({rows} rows)</span>
      </p>
      <Select aria-label={`Meaning of size ${value}`} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
        <option value="">Undecided (rows stay as errors)</option>
        <option value="keep">Keep “{value}” as the size</option>
        <option value="attribute">It is another detail (not a size)</option>
      </Select>
      {mode === 'attribute' ? (
        <>
          <Input aria-label={`Detail name for ${value}`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. ruling" />
          <Input aria-label={`Detail value for ${value}`} value={val} onChange={(e) => setVal(e.target.value)} placeholder="e.g. Single line" />
        </>
      ) : (
        <>
          <span />
          <span />
        </>
      )}
      <Button variant="outline" size="sm" loading={update.isPending} disabled={mode === 'attribute' && (!key.trim() || !val.trim())} onClick={save}>
        Save
      </Button>
    </div>
  );
}

function RulesCard({ batch }: { batch: ImportBatch }) {
  const update = useUpdateImportSettings(batch.id);
  const fail = useFeedback();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules for unclear values</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={batch.valueRules.gsmSuffix}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate({ version: batch.version, valueRules: { ...batch.valueRules, gsmSuffix: e.target.checked } }, { onError: fail('Could not save the rule') })
            }
          />
          <span>
            Numbers followed by G (e.g. 150G) are GSM
            {batch.gsmInNames > 0 && <span className="text-muted-foreground"> — found in {batch.gsmInNames} names</span>}
          </span>
        </label>
        {batch.sizeValues.length > 0 && (
          <div className="space-y-2">
            <p className="font-medium">Sizes that are not A-sizes: what do they mean?</p>
            {batch.sizeValues.map((s) => (
              <SizeRuleRow key={`${s.value}:${JSON.stringify(s.rule)}`} batch={batch} value={s.value} rows={s.rows} rule={s.rule} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BrandDecisionRow({ batch, candidate, brands }: { batch: ImportBatch; candidate: BrandCandidate; brands: SearchSelectOption[] }) {
  const update = useUpdateImportSettings(batch.id);
  const fail = useFeedback();
  const d = candidate.decision;
  const [mode, setMode] = useState<'' | BrandDecision['action']>(d?.action ?? '');
  const [name, setName] = useState(d?.action === 'create' ? d.name : titleCase(candidate.key));
  const [prefix, setPrefix] = useState(d && d.action !== 'not_brand' ? d.prefix : candidate.key);
  const [brandId, setBrandId] = useState(d?.action === 'existing' ? d.brandId : '');
  const selected = brands.find((b) => b.id === brandId) ?? null;

  function save(next: BrandDecision | null) {
    update.mutate({ version: batch.version, brandDecisions: { [candidate.key]: next } }, { onError: fail('Could not save the brand decision') });
  }

  const decision: BrandDecision | null =
    mode === 'not_brand'
      ? { action: 'not_brand' }
      : mode === 'create' && name.trim() && prefix.trim()
        ? { action: 'create', name: name.trim(), prefix: prefix.trim() }
        : mode === 'existing' && brandId && prefix.trim()
          ? { action: 'existing', brandId, prefix: prefix.trim() }
          : null;

  return (
    <li className="space-y-2 rounded-lg border p-3" data-testid={`brand-${candidate.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-semibold">{candidate.key}</span>{' '}
          <span className="text-sm text-muted-foreground">
            {candidate.rows} rows · e.g. {candidate.examples.join(', ')}
          </span>
        </p>
        {d ? <Badge tone="accent">Decided</Badge> : <Badge tone="warning">Needs a decision</Badge>}
      </div>
      {candidate.similarInFile.length > 0 && (
        <p className="callout callout-info text-sm">Looks like {candidate.similarInFile.join(', ')} — not merged automatically. Choose the same brand for both if they are one brand.</p>
      )}
      <div className="grid items-end gap-2 md:grid-cols-[14rem_1fr_1fr_auto]">
        <Select aria-label={`What is ${candidate.key}?`} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="">Undecided</option>
          <option value="existing">An existing brand</option>
          <option value="create">A new brand</option>
          <option value="not_brand">Not a brand (part of the name)</option>
        </Select>
        {mode === 'existing' && (
          <SearchSelect id={`brand-existing-${candidate.key}`} noun="brand" options={brands} value={selected} onChange={(o) => setBrandId(o?.id ?? '')} placeholder="Choose a brand" />
        )}
        {mode === 'create' && <Input aria-label={`New brand name for ${candidate.key}`} value={name} onChange={(e) => setName(e.target.value)} />}
        {(mode === 'existing' || mode === 'create') && (
          <Input aria-label={`Brand words at the start of the name for ${candidate.key}`} value={prefix} onChange={(e) => setPrefix(e.target.value)} title="The words removed from the start of the product name" />
        )}
        {mode === '' || mode === 'not_brand' ? (
          <>
            <span />
            <span />
          </>
        ) : null}
        <div className="flex gap-1">
          <Button variant="outline" size="sm" loading={update.isPending} disabled={decision === null} onClick={() => save(decision)}>
            Save
          </Button>
          {d && (
            <Button variant="ghost" size="sm" onClick={() => save(null)}>
              Clear
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function BrandsCard({ batch }: { batch: ImportBatch }) {
  const brands = useBrands('active');
  const options = useMemo(() => (brands.data ?? []).map((b) => ({ id: b.id, name: b.name, isActive: b.isActive })), [brands.data]);
  if (batch.brandCandidates.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Brands</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          These first words are not known brands. Decide for each: an existing brand, a new brand (created only when you import), or not a brand. Spellings are never
          merged for you.
        </p>
        <ul className="space-y-2">
          {batch.brandCandidates.map((c) => (
            <BrandDecisionRow key={`${c.key}:${JSON.stringify(c.decision)}`} batch={batch} candidate={c} brands={options} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SectionsCard({ batch }: { batch: ImportBatch }) {
  const categories = useCategories('active');
  const update = useUpdateImportSettings(batch.id);
  const fail = useFeedback();
  const usable = (categories.data ?? []).filter((c) => c.isProductUsable);
  if (batch.sections.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Categories by section</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {categories.isSuccess && usable.length === 0 && (
          <p className="callout callout-warning">
            No category is marked for products. Open <Link to="/categories" className="font-medium underline">Categories</Link> and switch on “Use for products”.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {batch.sections.map((s) => (
            <Field key={s.name} id={`section-${s.name}`} label={`${s.name} (${s.rows} rows)`}>
              <Select
                id={`section-${s.name}`}
                value={s.categoryId ?? ''}
                disabled={update.isPending}
                onChange={(e) =>
                  update.mutate({ version: batch.version, sectionCategories: { [s.name]: e.target.value || null } }, { onError: fail('Could not save the category') })
                }
              >
                <option value="">Choose a category</option>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Rows -------------------------------------------------------------------------------------------------

const rowKey = (r: { rowNumber: number; splitIndex: number }) => `${r.rowNumber}.${r.splitIndex}`;

function proposalText(r: ImportRow): ReactNode {
  const p = r.proposal;
  const parts = [
    p.size,
    p.pageCount ? `${p.pageCount} pages` : null,
    p.gsm ? `${p.gsm} GSM` : null,
    p.binding,
    ...Object.entries(p.attributes).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`),
    p.sellingUnit !== 'piece' ? `${p.sellingUnit}${p.packQty > 1 ? ` of ${p.packQty}` : ''}` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-0.5">
      <p className="font-medium">
        {p.brand ? <span className="text-muted-foreground">{p.brand.name} </span> : null}
        {p.name ?? <span className="text-destructive">no name</span>}
        {p.brand?.kind === 'new' && (
          <Badge tone="info" className="ml-1">
            new brand
          </Badge>
        )}
      </p>
      {parts.length > 0 && <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>}
      <p className="figure text-xs">
        {p.mrp ? `MRP ${formatInr(p.mrp)} · ` : 'No MRP · '}
        {p.sellingPrice ? `SP ${formatInr(p.sellingPrice)}` : <span className="text-destructive">no selling price</span>}
        {p.purchasePrice ? ` · cost ${formatInr(p.purchasePrice)}` : ''}
      </p>
      {p.categoryName && <p className="text-xs text-muted-foreground">{p.categoryName}</p>}
    </div>
  );
}

function decisionOptions(r: ImportRow): Decision[] {
  const options: Decision[] = ['pending', 'create'];
  if (r.matchedProduct) options.push('update');
  options.push('skip');
  return options;
}

function RowsCard({ batch }: { batch: ImportBatch }) {
  const [group, setGroup] = useState<Group | undefined>(batch.counts.error > 0 ? 'error' : undefined);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkName, setBulkName] = useState('');
  const [editing, setEditing] = useState<ImportRow | null>(null);
  const [splitting, setSplitting] = useState<ImportRow | null>(null);
  const rows = useImportRows(batch.id, { group, page });
  const updateRows = useUpdateImportRows(batch.id);
  const unsplit = useUnsplitImportRow(batch.id);
  const fail = useFeedback();
  const editable = batch.status === 'review';
  const items = rows.data?.items ?? [];
  const letters = sortLetters(Object.keys(batch.header));
  const selectedRows = items.filter((r) => selected.has(rowKey(r)));

  useEffect(() => setSelected(new Set()), [group, page]);

  function change(changes: { rowNumber: number; splitIndex: number; decision?: Decision; overrides?: RowOverrides | null }[]) {
    updateRows.mutate({ version: batch.version, rows: changes }, { onError: fail('Could not save the change'), onSuccess: () => setSelected(new Set()) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rows</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div role="tablist" aria-label="Row groups" className="flex flex-wrap gap-1">
          <Button role="tab" aria-selected={group === undefined} size="sm" variant={group === undefined ? 'soft' : 'ghost'} onClick={() => (setGroup(undefined), setPage(1))}>
            All ({batch.counts.total})
          </Button>
          {GROUPS.map((g) => (
            <Button
              key={g.value}
              role="tab"
              aria-selected={group === g.value}
              size="sm"
              variant={group === g.value ? 'soft' : 'ghost'}
              onClick={() => (setGroup(g.value), setPage(1))}
            >
              {g.label} ({batch.counts[g.value]})
            </Button>
          ))}
        </div>

        {editable && selectedRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-muted p-2 text-sm">
            <span>{selectedRows.length} selected</span>
            <Button size="sm" variant="outline" onClick={() => change(selectedRows.map((r) => ({ rowNumber: r.rowNumber, splitIndex: r.splitIndex, decision: 'skip' })))}>
              Skip
            </Button>
            <Button size="sm" variant="outline" onClick={() => change(selectedRows.map((r) => ({ rowNumber: r.rowNumber, splitIndex: r.splitIndex, decision: 'create' })))}>
              Create
            </Button>
            <Input aria-label="Name for the selected rows" className="h-9 w-56" placeholder="Product name" value={bulkName} onChange={(e) => setBulkName(e.target.value)} />
            <Button
              size="sm"
              variant="outline"
              disabled={!bulkName.trim()}
              onClick={() => change(selectedRows.map((r) => ({ rowNumber: r.rowNumber, splitIndex: r.splitIndex, overrides: { ...r.overrides, name: bulkName.trim() } })))}
            >
              Set name
            </Button>
          </div>
        )}

        {rows.isPending && <LoadingState label="Loading rows…" skeleton="table" />}
        {rows.isError && <p className="callout callout-danger">{importErrorMessage(rows.error)}</p>}
        {rows.isSuccess && items.length === 0 && <EmptyState title="No rows in this group">Choose another group above.</EmptyState>}
        {items.length > 0 && (
          <div className={cn('table-shell overflow-x-auto', rows.isPlaceholderData && 'opacity-70')}>
            <table className="data-table text-sm">
              <thead>
                <tr>
                  {editable && <th className="w-8 px-2 py-2" aria-label="Select" />}
                  <th className="px-2 py-2">Row</th>
                  <th className="px-2 py-2">As read</th>
                  <th className="px-2 py-2">Will become</th>
                  <th className="px-2 py-2">Problems</th>
                  <th className="px-2 py-2">Decision</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const errors = r.issues.filter((i) => i.severity === 'error');
                  const warnings = r.issues.filter((i) => i.severity === 'warning');
                  const canSplit = r.splitIndex === 0 && r.issues.some((i) => i.code === 'DUAL_PRICE' || i.code === 'ALTERNATIVE_VALUES' || i.code === 'PER_PIECE_PRICE');
                  return (
                    <tr key={rowKey(r)} className={cn(r.effectiveDecision === 'skip' && 'text-muted-foreground')}>
                      {editable && (
                        <td className="px-2 py-2 align-top">
                          <input
                            type="checkbox"
                            className="size-4"
                            aria-label={`Select row ${r.rowNumber}${r.splitIndex ? ` part ${r.splitIndex}` : ''}`}
                            checked={selected.has(rowKey(r))}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(rowKey(r));
                              else next.delete(rowKey(r));
                              setSelected(next);
                            }}
                          />
                        </td>
                      )}
                      <td className="whitespace-nowrap px-2 py-2 align-top">
                        <p className="font-medium">
                          {r.rowNumber}
                          {r.splitIndex > 0 && <span className="text-muted-foreground"> · part {r.splitIndex}</span>}
                        </p>
                        {r.section && <p className="text-xs text-muted-foreground">{r.section}</p>}
                        {r.duplicateOf !== null && <p className="text-xs text-muted-foreground">same as row {r.duplicateOf}</p>}
                      </td>
                      <td className="px-2 py-2 align-top">
                        <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                          {letters
                            .filter((l) => r.raw[l] !== undefined)
                            .map((l) => (
                              <div key={l} className="contents">
                                <dt className="text-muted-foreground">{batch.header[l] || l}</dt>
                                <dd>
                                  <RawValue value={r.raw[l]} />
                                </dd>
                              </div>
                            ))}
                        </dl>
                      </td>
                      <td className="px-2 py-2 align-top">
                        {proposalText(r)}
                        {r.matchedProduct && (
                          <p className="mt-1 text-xs">
                            Matches{' '}
                            <Link to={`/products/${r.matchedProduct.id}`} className="underline" target="_blank" rel="noreferrer">
                              {r.matchedProduct.brand ? `${r.matchedProduct.brand} ` : ''}
                              {r.matchedProduct.name}
                            </Link>{' '}
                            (now SP {formatInr(r.matchedProduct.sellingPrice)})
                          </p>
                        )}
                      </td>
                      <td className="max-w-80 px-2 py-2 align-top">
                        <ul className="space-y-1 text-xs">
                          {errors.map((i, n) => (
                            <li key={`e${n}`} className="text-destructive">
                              {i.message}
                            </li>
                          ))}
                          {warnings.map((i, n) => (
                            <li key={`w${n}`} className="text-warning-strong">
                              {i.message}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="px-2 py-2 align-top">
                        {editable ? (
                          <div className="space-y-1">
                            <Select
                              aria-label={`Decision for row ${r.rowNumber}${r.splitIndex ? ` part ${r.splitIndex}` : ''}`}
                              className="h-9"
                              value={r.decision === 'pending' ? 'pending' : r.decision}
                              onChange={(e) => change([{ rowNumber: r.rowNumber, splitIndex: r.splitIndex, decision: e.target.value as Decision }])}
                            >
                              {decisionOptions(r).map((d) => (
                                <option key={d} value={d}>
                                  {d === 'pending' ? `Default (${DECISION_LABEL[r.effectiveDecision]})` : DECISION_LABEL[d]}
                                </option>
                              ))}
                            </Select>
                            <div className="flex flex-wrap gap-1">
                              <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                                Edit
                              </Button>
                              {r.proposal.suggestedName && !r.proposal.name && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => change([{ rowNumber: r.rowNumber, splitIndex: r.splitIndex, overrides: { ...r.overrides, name: r.proposal.suggestedName! } }])}
                                >
                                  Use “{r.proposal.suggestedName}”
                                </Button>
                              )}
                              {canSplit && (
                                <Button size="sm" variant="ghost" onClick={() => setSplitting(r)}>
                                  <Scissors aria-hidden="true" /> Split
                                </Button>
                              )}
                              {r.splitIndex > 0 && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={unsplit.isPending}
                                  onClick={() => unsplit.mutate({ rowNumber: r.rowNumber, version: batch.version }, { onError: fail('Could not undo the split') })}
                                >
                                  <Undo2 aria-hidden="true" /> Undo split
                                </Button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span>{DECISION_LABEL[r.effectiveDecision]}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.data && rows.data.pagination.totalPages > 1 && (
          <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="text-muted-foreground">
              Page {page} of {rows.data.pagination.totalPages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= rows.data.pagination.totalPages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </nav>
        )}
      </CardContent>
      {editing && <RowEditDialog batch={batch} row={editing} onClose={() => setEditing(null)} />}
      {splitting && <SplitDialog batch={batch} row={splitting} onClose={() => setSplitting(null)} />}
    </Card>
  );
}

// --- Row edit -----------------------------------------------------------------------------------------------

interface PartFields {
  name: string;
  pageCount: string;
  sellingUnit: SellingUnit;
  packQty: string;
  noMrp: boolean;
  mrp: string;
  sellingPrice: string;
}

const UNITS: SellingUnit[] = ['piece', 'pack', 'box', 'set', 'ream'];
const intOrNull = (v: string) => (v.trim() === '' ? null : Number(v));
const validInt = (v: string) => v.trim() === '' || /^\d+$/.test(v.trim());
const validMoney = (v: string) => v.trim() === '' || MONEY_INPUT.test(v.trim());

function RowEditDialog({ batch, row, onClose }: { batch: ImportBatch; row: ImportRow; onClose: () => void }) {
  const update = useUpdateImportRows(batch.id);
  const fail = useFeedback();
  const brands = useBrands('active');
  const categories = useCategories('active');
  const p = row.proposal;
  const [f, setF] = useState({
    name: p.name ?? '',
    brand: p.brand?.kind === 'existing' ? p.brand.id : p.brand ? 'proposal' : 'none',
    categoryId: p.categoryId ?? '',
    size: p.size ?? '',
    pageCount: p.pageCount ? String(p.pageCount) : '',
    gsm: p.gsm ? String(p.gsm) : '',
    binding: p.binding ?? '',
    sellingUnit: p.sellingUnit,
    packQty: String(p.packQty),
    noMrp: p.mrp === null,
    mrp: p.mrp ?? '',
    sellingPrice: p.sellingPrice ?? '',
    purchasePrice: p.purchasePrice ?? '',
    sku: p.sku ?? '',
    barcode: p.barcode ?? '',
    description: p.description ?? '',
    confirmSpAboveMrp: p.confirmSpAboveMrp,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const needsSpConfirm = row.issues.some((i) => i.code === 'SP_ABOVE_MRP') || p.confirmSpAboveMrp;
  const invalid =
    !f.name.trim() ||
    !validInt(f.pageCount) ||
    !validInt(f.gsm) ||
    !/^\d+$/.test(f.packQty) ||
    !validMoney(f.mrp) ||
    !validMoney(f.purchasePrice) ||
    !MONEY_INPUT.test(f.sellingPrice.trim());

  function save() {
    // Only fields that differ from what was read become overrides (the rest keeps following the rules).
    const o: RowOverrides = { ...row.overrides };
    const differs = <T,>(a: T, b: T) => JSON.stringify(a) !== JSON.stringify(b);
    if (differs(f.name.trim(), p.name ?? '')) o.name = f.name.trim();
    if (f.brand !== 'proposal') {
      const brandId = f.brand === 'none' ? null : f.brand;
      if (differs(brandId, p.brand?.kind === 'existing' ? p.brand.id : p.brand ? '' : null)) o.brandId = brandId;
    }
    if (f.categoryId && f.categoryId !== p.categoryId) o.categoryId = f.categoryId;
    if (differs(f.size.trim() || null, p.size)) o.size = f.size.trim() || null;
    if (differs(intOrNull(f.pageCount), p.pageCount)) o.pageCount = intOrNull(f.pageCount);
    if (differs(intOrNull(f.gsm), p.gsm)) o.gsm = intOrNull(f.gsm);
    if (differs(f.binding.trim() || null, p.binding)) o.binding = f.binding.trim() || null;
    if (f.sellingUnit !== p.sellingUnit) o.sellingUnit = f.sellingUnit;
    if (Number(f.packQty) !== p.packQty) o.packQty = Number(f.packQty);
    const mrp = f.noMrp ? null : f.mrp.trim() || null;
    if (differs(mrp, p.mrp)) o.mrp = mrp;
    if (f.sellingPrice.trim() !== (p.sellingPrice ?? '')) o.sellingPrice = f.sellingPrice.trim();
    const cost = f.purchasePrice.trim() || null;
    if (differs(cost, p.purchasePrice)) o.purchasePrice = cost;
    if (differs(f.sku.trim() || null, p.sku)) o.sku = f.sku.trim() || null;
    if (differs(f.barcode.trim() || null, p.barcode)) o.barcode = f.barcode.trim() || null;
    if (differs(f.description.trim() || null, p.description)) o.description = f.description.trim() || null;
    if (needsSpConfirm) o.confirmSpAboveMrp = f.confirmSpAboveMrp;
    update.mutate(
      { version: batch.version, rows: [{ rowNumber: row.rowNumber, splitIndex: row.splitIndex, overrides: o }] },
      { onSuccess: onClose, onError: fail('Could not save the row') },
    );
  }

  return (
    <Dialog
      open
      title={`Row ${row.rowNumber}${row.splitIndex ? `, part ${row.splitIndex}` : ''}`}
      onClose={onClose}
      dismissible={!update.isPending}
      size="lg"
      footer={
        <DialogActions>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          {Object.keys(row.overrides).length > 0 && (
            <Button
              variant="ghost"
              onClick={() =>
                update.mutate(
                  { version: batch.version, rows: [{ rowNumber: row.rowNumber, splitIndex: row.splitIndex, overrides: null }] },
                  { onSuccess: onClose, onError: fail('Could not reset the row') },
                )
              }
            >
              Undo my edits
            </Button>
          )}
          <Button loading={update.isPending} disabled={invalid} onClick={save}>
            Save row
          </Button>
        </DialogActions>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field id="row-name" label="Product name (without brand)" className="md:col-span-2">
          <Input id="row-name" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field id="row-brand" label="Brand">
          <Select id="row-brand" value={f.brand} onChange={(e) => set('brand', e.target.value)}>
            {p.brand?.kind === 'new' && <option value="proposal">{p.brand.name} (new brand, from the decision)</option>}
            <option value="none">No brand</option>
            {(brands.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="row-category" label="Category">
          <Select id="row-category" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="">Choose a category</option>
            {(categories.data ?? [])
              .filter((c) => c.isProductUsable)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field id="row-size" label="Size">
          <Input id="row-size" value={f.size} onChange={(e) => set('size', e.target.value)} />
        </Field>
        <Field id="row-pages" label="Pages" error={validInt(f.pageCount) ? undefined : 'A whole number'}>
          <Input id="row-pages" inputMode="numeric" value={f.pageCount} onChange={(e) => set('pageCount', e.target.value)} />
        </Field>
        <Field id="row-gsm" label="GSM" error={validInt(f.gsm) ? undefined : 'A whole number'}>
          <Input id="row-gsm" inputMode="numeric" value={f.gsm} onChange={(e) => set('gsm', e.target.value)} />
        </Field>
        <Field id="row-binding" label="Binding">
          <Input id="row-binding" value={f.binding} onChange={(e) => set('binding', e.target.value)} />
        </Field>
        <Field id="row-unit" label="Sold by the">
          <Select id="row-unit" value={f.sellingUnit} onChange={(e) => setF({ ...f, sellingUnit: e.target.value as SellingUnit, packQty: e.target.value === 'piece' ? '1' : f.packQty })}>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="row-pack" label="Pieces in it" error={/^\d+$/.test(f.packQty) ? undefined : 'A whole number'}>
          <Input id="row-pack" inputMode="numeric" disabled={f.sellingUnit === 'piece'} value={f.packQty} onChange={(e) => set('packQty', e.target.value)} />
        </Field>
        <div className="space-y-1.5">
          <Field id="row-mrp" label="MRP" error={validMoney(f.mrp) ? undefined : 'An amount like 45 or 45.50'}>
            <Input id="row-mrp" inputMode="decimal" disabled={f.noMrp} value={f.noMrp ? '' : f.mrp} onChange={(e) => set('mrp', e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={f.noMrp} onChange={(e) => set('noMrp', e.target.checked)} /> No MRP
          </label>
        </div>
        <Field id="row-sp" label="Selling price" error={MONEY_INPUT.test(f.sellingPrice.trim()) ? undefined : 'Enter the selling price'}>
          <Input id="row-sp" inputMode="decimal" value={f.sellingPrice} onChange={(e) => set('sellingPrice', e.target.value)} />
        </Field>
        <Field id="row-cost" label="Purchase price (optional)" error={validMoney(f.purchasePrice) ? undefined : 'An amount like 45 or 45.50'}>
          <Input id="row-cost" inputMode="decimal" value={f.purchasePrice} onChange={(e) => set('purchasePrice', e.target.value)} />
        </Field>
        <Field id="row-sku" label="SKU">
          <Input id="row-sku" value={f.sku} onChange={(e) => set('sku', e.target.value)} />
        </Field>
        <Field id="row-barcode" label="Barcode">
          <Input id="row-barcode" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} />
        </Field>
        <Field id="row-notes" label="Notes / description" className="md:col-span-2">
          <Input id="row-notes" value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        {needsSpConfirm && (
          <label className="callout callout-warning flex items-start gap-2 text-sm md:col-span-2">
            <input type="checkbox" className="mt-0.5 size-4" checked={f.confirmSpAboveMrp} onChange={(e) => set('confirmSpAboveMrp', e.target.checked)} />I confirm the selling
            price above MRP
          </label>
        )}
      </div>
    </Dialog>
  );
}

// --- Split ---------------------------------------------------------------------------------------------------

function initialParts(row: ImportRow): PartFields[] {
  const p = row.proposal;
  const base: PartFields = {
    name: p.name ?? '',
    pageCount: p.pageCount ? String(p.pageCount) : '',
    sellingUnit: p.sellingUnit,
    packQty: String(p.packQty),
    noMrp: p.mrp === null,
    mrp: p.mrp ?? '',
    sellingPrice: p.sellingPrice ?? '',
  };
  const dual = row.issues.find((i) => i.code === 'DUAL_PRICE');
  if (dual) {
    return [
      { ...base, sellingUnit: 'pack', packQty: '', sellingPrice: String(dual.meta?.packPrice ?? '') },
      { ...base, sellingUnit: 'piece', packQty: '1', noMrp: true, mrp: '', sellingPrice: String(dual.meta?.piecePrice ?? '') },
    ];
  }
  const alternatives = row.issues.find((i) => i.code === 'ALTERNATIVE_VALUES');
  const values = Array.isArray(alternatives?.meta?.values) ? (alternatives.meta.values as number[]) : null;
  if (values && values.length >= 2) return values.slice(0, 5).map((v) => ({ ...base, pageCount: String(v) }));
  return [{ ...base }, { ...base }];
}

function SplitDialog({ batch, row, onClose }: { batch: ImportBatch; row: ImportRow; onClose: () => void }) {
  const split = useSplitImportRow(batch.id);
  const fail = useFeedback();
  const [parts, setParts] = useState<PartFields[]>(() => initialParts(row));
  const setPart = (i: number, patch: Partial<PartFields>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const invalid = parts.some(
    (p) => !p.name.trim() || !validInt(p.pageCount) || !/^\d+$/.test(p.packQty) || !MONEY_INPUT.test(p.sellingPrice.trim()) || (!p.noMrp && !validMoney(p.mrp)),
  );

  function save() {
    const overrides: RowOverrides[] = parts.map((p) => ({
      name: p.name.trim(),
      pageCount: intOrNull(p.pageCount),
      sellingUnit: p.sellingUnit,
      packQty: Number(p.packQty),
      mrp: p.noMrp ? null : p.mrp.trim() || null,
      sellingPrice: p.sellingPrice.trim(),
    }));
    split.mutate({ rowNumber: row.rowNumber, version: batch.version, parts: overrides }, { onSuccess: onClose, onError: fail('Could not split the row') });
  }

  return (
    <Dialog
      open
      title={`Split row ${row.rowNumber} into separate products`}
      onClose={onClose}
      dismissible={!split.isPending}
      size="lg"
      footer={
        <DialogActions>
          <Button variant="outline" onClick={onClose} disabled={split.isPending}>
            Cancel
          </Button>
          <Button loading={split.isPending} disabled={invalid} onClick={save}>
            Split row
          </Button>
        </DialogActions>
      }
    >
      <p className="mb-3 text-sm text-muted-foreground">
        Each part becomes its own product. Prices are only what you type: nothing is calculated. A pack needs its number of pieces.
      </p>
      <div className="space-y-3">
        {parts.map((p, i) => (
          <fieldset key={i} className="grid gap-2 rounded-lg border p-3 md:grid-cols-3">
            <legend className="px-1 text-sm font-medium">Part {i + 1}</legend>
            <Field id={`part-${i}-name`} label="Name">
              <Input id={`part-${i}-name`} value={p.name} onChange={(e) => setPart(i, { name: e.target.value })} />
            </Field>
            <Field id={`part-${i}-pages`} label="Pages">
              <Input id={`part-${i}-pages`} inputMode="numeric" value={p.pageCount} onChange={(e) => setPart(i, { pageCount: e.target.value })} />
            </Field>
            <Field id={`part-${i}-unit`} label="Sold by the">
              <Select
                id={`part-${i}-unit`}
                value={p.sellingUnit}
                onChange={(e) => setPart(i, { sellingUnit: e.target.value as SellingUnit, packQty: e.target.value === 'piece' ? '1' : p.packQty })}
              >
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={`part-${i}-pack`} label="Pieces in it" error={/^\d+$/.test(p.packQty) ? undefined : 'Enter the number of pieces'}>
              <Input id={`part-${i}-pack`} inputMode="numeric" disabled={p.sellingUnit === 'piece'} value={p.packQty} onChange={(e) => setPart(i, { packQty: e.target.value })} />
            </Field>
            <div className="space-y-1">
              <Field id={`part-${i}-mrp`} label="MRP">
                <Input id={`part-${i}-mrp`} inputMode="decimal" disabled={p.noMrp} value={p.noMrp ? '' : p.mrp} onChange={(e) => setPart(i, { mrp: e.target.value })} />
              </Field>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" className="size-4" checked={p.noMrp} onChange={(e) => setPart(i, { noMrp: e.target.checked })} /> No MRP
              </label>
            </div>
            <Field id={`part-${i}-sp`} label="Selling price">
              <Input id={`part-${i}-sp`} inputMode="decimal" value={p.sellingPrice} onChange={(e) => setPart(i, { sellingPrice: e.target.value })} />
            </Field>
          </fieldset>
        ))}
        {parts.length < 5 && (
          <Button variant="outline" size="sm" onClick={() => setParts([...parts, { ...parts[parts.length - 1]! }])}>
            Add a part
          </Button>
        )}
      </div>
    </Dialog>
  );
}
