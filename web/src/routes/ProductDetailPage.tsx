import { Archive, ArchiveRestore, Eye, EyeOff, History, Pencil } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MoneyInput } from '@/components/finance/MoneyInput';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { AuditHistory } from '@/features/audit/AuditHistory';
import { useAuth } from '@/features/auth/auth-context';
import { PurchasePriceValue, specSummary, UNIT_LABELS } from '@/features/products/product-display';
import { ProductSuppliersCard } from '@/features/products/ProductSuppliersCard';
import { PRODUCT_COSTS_ROOT, useProduct, useProductCostHistory, useProductCosts, useProductHistory, useSetDefaultCost, useUpdateProduct } from '@/features/products/products-api';
import { useHidePricesOnError, usePurchasePriceReveal } from '@/features/products/usePurchasePriceReveal';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/dates';
import { formatInr, MONEY_INPUT } from '@/lib/money';

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  brand: 'Brand',
  category: 'Category',
  sku: 'SKU',
  barcode: 'Barcode',
  description: 'Description',
  size: 'Size',
  pageCount: 'Pages',
  gsm: 'GSM',
  binding: 'Binding',
  sellingUnit: 'Sold by',
  packQty: 'Pieces',
  attributes: 'Details',
  searchAliases: 'Other names',
  mrp: 'MRP',
  sellingPrice: 'Selling price',
  isActive: 'Active',
  spAboveMrpConfirmed: 'Selling above MRP confirmed',
  supplier: 'Supplier',
  supplierProductCode: 'Supplier code',
  notes: 'Notes',
  isPreferred: 'Preferred',
  linked: 'Linked',
  purchasePrice: 'Purchase price',
  importBatchId: 'Imported (batch)',
  sourceRow: 'Source row',
};
const display = (field: string, value: unknown) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if ((field === 'mrp' || field === 'sellingPrice' || field === 'purchasePrice') && typeof value === 'string' && MONEY_INPUT.test(value.replace(/\.00$/, ''))) {
    return formatInr(value);
  }
  return String(value);
};

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const product = useProduct(id);
  const { user } = useAuth();
  const canSeeCosts = user?.canViewPurchasePrices === true;
  const canEditCosts = canSeeCosts && user?.canEditPurchasePrices === true;
  const update = useUpdateProduct();
  const toast = useToast();
  const [dialog, setDialog] = useState<'status' | 'history' | 'cost' | null>(null);
  const history = useProductHistory(id, dialog === 'history');
  const reveal = usePurchasePriceReveal(id);
  const costs = useProductCosts(id, canSeeCosts && reveal.revealed);
  useHidePricesOnError(costs.error, reveal.hide);

  if (product.isPending) return <LoadingState label="Loading product…" skeleton="detail" />;
  if (product.isError) return <ErrorState title="Could not load this product" error={product.error} />;
  const p = product.data;
  const specs = specSummary(p);
  const details = Object.entries(p.attributes);

  return (
    <Page width="medium">
      <PageHeader
        back={{ to: '/products', label: 'Products' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.brand && <span className="text-muted-foreground">{p.brand.name}</span>}
            {p.name}
            {!p.isActive && <Badge>Deactivated</Badge>}
          </span>
        }
        actions={
          <>
            <Link to={`/products/${p.id}/edit`} className={buttonVariants({ variant: 'outline' })}>
              <Pencil aria-hidden="true" /> Edit
            </Link>
            <Button variant="outline" onClick={() => setDialog('status')}>
              {p.isActive ? <Archive aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
              {p.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
            <Button variant="ghost" onClick={() => setDialog('history')}>
              <History aria-hidden="true" /> History
            </Button>
          </>
        }
      />

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Prices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">Selling price</span>
              <span className="figure text-2xl font-semibold">{formatInr(p.sellingPrice)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">MRP</span>
              <span className="figure">{p.mrp ? formatInr(p.mrp) : 'Not set'}</span>
            </div>
            <p className="text-xs text-muted-foreground">Per {UNIT_LABELS[p.sellingUnit].toLowerCase()}{p.packQty > 1 ? ` of ${p.packQty}` : ''}.</p>
            {p.spAboveMrpConfirmation && (
              <p className="callout callout-warning text-sm">
                Selling above the MRP was confirmed by {p.spAboveMrpConfirmation.by.name} on {formatDateTime(p.spAboveMrpConfirmation.at)}.
              </p>
            )}
            {canSeeCosts && (
              <div className={reveal.revealed ? 'rounded-lg bg-info-soft/50 p-3' : 'rounded-lg border border-dashed p-3'} data-testid="cost-card">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Purchase price</span>
                  <Button size="sm" variant="ghost" aria-pressed={reveal.revealed} onClick={() => (reveal.revealed ? reveal.hide() : reveal.reveal())}>
                    {reveal.revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    {reveal.revealed ? 'Hide' : 'Show'}
                  </Button>
                </div>
                {!reveal.revealed && <PurchasePriceValue revealed={false} value={null} />}
                {reveal.revealed && costs.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
                {reveal.revealed && costs.isError && <p className="text-sm text-destructive">{errorMessage(costs.error)}</p>}
                {reveal.revealed && costs.isSuccess && (
                  <div className="space-y-1.5 text-sm">
                    <p className="flex items-baseline justify-between gap-2">
                      <span>Used price</span>
                      <PurchasePriceValue revealed value={costs.data.effectivePurchasePrice} />
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {costs.data.source === 'preferred_supplier'
                        ? `From the preferred supplier (${costs.data.preferredSupplier?.name}).`
                        : costs.data.source === 'default'
                          ? 'The default purchase price (no preferred supplier price).'
                          : 'No purchase price recorded.'}
                    </p>
                    <p className="flex items-baseline justify-between gap-2">
                      <span>Default purchase price</span>
                      <span className="figure">{costs.data.defaultPurchasePrice ? formatInr(costs.data.defaultPurchasePrice) : 'Not set'}</span>
                    </p>
                    {costs.data.warnings.map((w) => (
                      <p key={w.code} className="callout callout-warning text-xs">
                        {w.message}
                      </p>
                    ))}
                    {canEditCosts && <Button size="sm" variant="outline" onClick={() => setDialog('cost')}>
                      <Pencil aria-hidden="true" /> Change default price
                    </Button>}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Brand</dt>
              <dd>{p.brand ? p.brand.name : 'No brand'}</dd>
              <dt className="text-muted-foreground">Category</dt>
              <dd>{p.category.name}</dd>
              {specs && (
                <>
                  <dt className="text-muted-foreground">Specifications</dt>
                  <dd>{specs}</dd>
                </>
              )}
              {details.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="capitalize text-muted-foreground">{k.replace(/_/g, ' ')}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
              <dt className="text-muted-foreground">SKU</dt>
              <dd>{p.sku ?? '—'}</dd>
              <dt className="text-muted-foreground">Barcode</dt>
              <dd className="break-all">{p.barcode ?? '—'}</dd>
              {p.searchAliases.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Other names</dt>
                  <dd>{p.searchAliases.join(', ')}</dd>
                </>
              )}
            </dl>
            {p.description && <p className="mt-3 whitespace-pre-line text-sm text-muted-foreground">{p.description}</p>}
            <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
              Added {formatDateTime(p.createdAt)} by {p.createdBy.name} · last changed {formatDateTime(p.updatedAt)} by {p.updatedBy.name}
            </p>
          </CardContent>
        </Card>
      </div>

      <ProductSuppliersCard
        productId={p.id}
        canSeeCosts={canSeeCosts}
        canEditCosts={canEditCosts}
        supplierPrices={reveal.revealed && costs.isSuccess ? new Map(costs.data.suppliers.map((s) => [s.supplierId, s.purchasePrice])) : null}
      />

      <Dialog
        open={dialog === 'status'}
        title={p.isActive ? 'Deactivate product?' : 'Reactivate product?'}
        onClose={() => {
          update.reset();
          setDialog(null);
        }}
        dismissible={!update.isPending}
        size="sm"
        footer={
          <DialogActions>
            <Button variant="outline" disabled={update.isPending} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={p.isActive ? 'destructive' : 'default'}
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: p.id, version: p.version, isActive: !p.isActive },
                  {
                    onSuccess: (saved) => {
                      toast({ title: saved.isActive ? 'Product reactivated' : 'Product deactivated', description: saved.name, tone: 'success' });
                      setDialog(null);
                    },
                  },
                )
              }
            >
              {update.isPending ? 'Saving…' : p.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">
          {p.isActive
            ? `“${p.name}” will be hidden from the catalogue and from quick lookup. Nothing is deleted: details, prices and history stay available under “Deactivated”.`
            : `“${p.name}” will appear in the catalogue again.`}
        </p>
        {update.isError && (
          <p role="alert" className="mt-3 callout callout-danger">
            {errorMessage(update.error)}
            {update.error instanceof ApiError && (update.error.code === 'SKU_TAKEN' || update.error.code === 'BARCODE_TAKEN') && ' Edit this product to change its code, then reactivate it.'}
          </p>
        )}
      </Dialog>

      <Dialog open={dialog === 'history'} title={`History: ${p.name}`} onClose={() => setDialog(null)}>
        <AuditHistory history={history} fieldLabels={FIELD_LABELS} display={display} />
        {canSeeCosts && <CostHistorySection productId={p.id} />}
      </Dialog>

      {dialog === 'cost' && costs.data && (
        <CostDialog productId={p.id} current={costs.data.defaultPurchasePrice} version={costs.data.version} onClose={() => setDialog(null)} />
      )}
    </Page>
  );
}

/**
 * Purchase-price changes, shown only on request inside the History dialog. Protected endpoint,
 * recorded in the access trail, never cached after hiding, closing the dialog or the tab going to
 * the background (the ordinary product history never contains purchase prices).
 */
function CostHistorySection({ productId }: { productId: string }) {
  const queryClient = useQueryClient();
  const [shown, setShown] = useState(false);
  const history = useProductCostHistory(productId, shown);
  const hide = useCallback(() => setShown(false), []);
  // Forget once the query is switched off (removing an enabled query would refetch it).
  useEffect(() => {
    if (!shown) queryClient.removeQueries({ queryKey: [PRODUCT_COSTS_ROOT, 'history', productId] });
  }, [shown, queryClient, productId]);
  useHidePricesOnError(history.error, hide);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      queryClient.removeQueries({ queryKey: [PRODUCT_COSTS_ROOT, 'history', productId] });
    };
  }, [hide, queryClient, productId]);
  return (
    <section className="mt-4 border-t pt-3" aria-label="Purchase-price changes">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Purchase-price changes</h3>
        <Button size="sm" variant="ghost" aria-pressed={shown} onClick={() => (shown ? hide() : setShown(true))}>
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {shown ? 'Hide' : 'Show'}
        </Button>
      </div>
      {shown && <AuditHistory history={history} fieldLabels={FIELD_LABELS} display={display} />}
    </section>
  );
}

function CostDialog({ productId, current, version, onClose }: { productId: string; current: string | null; version: number; onClose: () => void }) {
  const [value, setValue] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const setCost = useSetDefaultCost(productId);
  const toast = useToast();
  return (
    <Dialog
      open
      title="Default purchase price"
      size="sm"
      onClose={onClose}
      dismissible={!setCost.isPending}
      footer={
        <DialogActions>
          <Button variant="outline" onClick={onClose} disabled={setCost.isPending}>
            Cancel
          </Button>
          <Button
            loading={setCost.isPending}
            onClick={() => {
              if (value !== '' && !MONEY_INPUT.test(value)) {
                setError('Enter an amount like 45 or 45.50');
                return;
              }
              setCost.mutate(
                { defaultPurchasePrice: value === '' ? null : value, version },
                {
                  onSuccess: () => {
                    toast({ title: 'Purchase price saved', tone: 'success' });
                    onClose();
                  },
                  onError: (err) => setError(errorMessage(err)),
                },
              );
            }}
          >
            Save
          </Button>
        </DialogActions>
      }
    >
      <div className="space-y-2">
        <MoneyInput aria-label="Default purchase price" className="bg-info-soft/40" value={value} onChange={(e) => setValue(e.target.value)} />
        <p className="text-xs text-muted-foreground">Leave empty to remove it. Used when there is no preferred supplier price. The change is recorded in the history.</p>
        {error && (
          <p role="alert" className="callout callout-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
