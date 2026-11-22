import { Link2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MoneyInput } from '@/components/finance/MoneyInput';
import { errorMessage } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { SupplierPicker } from '@/features/suppliers/SupplierPicker';
import { MONEY_INPUT } from '@/lib/money';
import type { ProductSupplierLink, SupplierRef } from '@/types/api';
import { PurchasePriceValue } from './product-display';
import { useLinkSupplier, useProductSuppliers, useSupplierSuggestions, useUnlinkSupplier, useUpdateSupplierLink } from './products-api';

type Editing = { mode: 'add' } | { mode: 'edit'; link: ProductSupplierLink } | null;

/**
 * Suppliers a product can be bought from. Everyone may link suppliers, mark the preferred one and
 * keep a supplier's product code; purchase prices are shown (masked until revealed) and editable
 * ONLY for users allowed to see them. Supplier defaults (brands / categories) are never changed here.
 */
export function ProductSuppliersCard({
  productId,
  canSeeCosts,
  canEditCosts,
  supplierPrices,
}: {
  productId: string;
  canSeeCosts: boolean;
  /** May change purchase prices (owner, or a manager with that separate permission). */
  canEditCosts: boolean;
  /** Supplier prices from the protected cost endpoint, only while revealed (null = hidden). */
  supplierPrices: Map<string, string | null> | null;
}) {
  const costsRevealed = supplierPrices !== null;
  const links = useProductSuppliers(productId);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<ProductSupplierLink | null>(null);
  const suggestions = useSupplierSuggestions(productId, editing?.mode === 'add');
  const update = useUpdateSupplierLink(productId);
  const unlink = useUnlinkSupplier(productId);
  const toast = useToast();

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Suppliers</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setEditing({ mode: 'add' })}>
          <Plus aria-hidden="true" /> Link supplier
        </Button>
      </CardHeader>
      <CardContent>
        {links.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {links.isError && <p className="text-sm text-destructive">{errorMessage(links.error)}</p>}
        {links.isSuccess && links.data.length === 0 && <p className="text-sm text-muted-foreground">No supplier linked yet.</p>}
        {links.isSuccess && links.data.length > 0 && (
          <ul className="divide-y">
            {links.data.map((l) => (
              <li key={l.supplierId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {l.supplierName}
                    {l.isPreferred && (
                      <Badge tone="accent">
                        <Star className="size-3" aria-hidden="true" /> Preferred
                      </Badge>
                    )}
                    {!l.supplierActive && <Badge>Archived supplier</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">{[l.supplierProductCode && `Code ${l.supplierProductCode}`, l.notes].filter(Boolean).join(' · ') || 'No code'}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  {canSeeCosts && <PurchasePriceValue revealed={costsRevealed} value={supplierPrices?.get(l.supplierId) ?? null} />}
                  {!l.isPreferred && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={update.isPending && update.variables?.supplierId === l.supplierId}
                      onClick={() =>
                        update.mutate(
                          { supplierId: l.supplierId, version: l.version, isPreferred: true },
                          { onError: (err) => toast({ title: 'Could not change the preferred supplier', description: errorMessage(err), tone: 'error' }) },
                        )
                      }
                    >
                      <Star aria-hidden="true" /> Make preferred
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" aria-label={`Edit link to ${l.supplierName}`} onClick={() => setEditing({ mode: 'edit', link: l })}>
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Unlink ${l.supplierName}`} onClick={() => setRemoving(l)}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {editing && (
        <LinkDialog
          productId={productId}
          editing={editing}
          canEditCosts={canEditCosts}
          priceRevealed={costsRevealed}
          currentPrice={editing.mode === 'edit' ? (supplierPrices?.get(editing.link.supplierId) ?? null) : null}
          suggestions={suggestions.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}

      <Dialog
        open={removing !== null}
        title="Unlink supplier?"
        size="sm"
        onClose={() => setRemoving(null)}
        dismissible={!unlink.isPending}
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={unlink.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={unlink.isPending}
              onClick={() =>
                removing &&
                // The version the user saw: if someone changed the link meanwhile, the server answers
                // 409 and the list refreshes (useLinkMutation invalidates it) instead of removing it.
                unlink.mutate({ supplierId: removing.supplierId, version: removing.version }, {
                  onSuccess: () => {
                    toast({ title: 'Supplier unlinked', description: removing.supplierName, tone: 'success' });
                    setRemoving(null);
                  },
                  onError: (err) => toast({ title: 'Could not unlink the supplier', description: errorMessage(err), tone: 'error' }),
                })
              }
            >
              Unlink
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">“{removing?.supplierName}” will no longer be listed for this product. The supplier itself is not changed.</p>
      </Dialog>
    </Card>
  );
}

function LinkDialog({
  productId,
  editing,
  canEditCosts,
  priceRevealed,
  currentPrice,
  suggestions,
  onClose,
}: {
  productId: string;
  editing: NonNullable<Editing>;
  canEditCosts: boolean;
  priceRevealed: boolean;
  currentPrice: string | null;
  suggestions: { id: string; name: string; phone: string | null }[];
  onClose: () => void;
}) {
  const link = editing.mode === 'edit' ? editing.link : null;
  const [supplier, setSupplier] = useState<SupplierRef | null>(null);
  const [code, setCode] = useState(link?.supplierProductCode ?? '');
  const [notes, setNotes] = useState(link?.notes ?? '');
  const [preferred, setPreferred] = useState(link?.isPreferred ?? false);
  const [price, setPrice] = useState(currentPrice ?? '');
  // A new link may get a price straight away; an existing link's price is edited only while revealed.
  const priceEditable = canEditCosts && (!link || priceRevealed);
  // Prices hidden while this dialog is open (Hide, tab in the background): drop the loaded price
  // from memory. In that state the price field is gone and saving never sends a price.
  useEffect(() => {
    if (!priceEditable) setPrice('');
  }, [priceEditable]);
  const [error, setError] = useState<string | null>(null);
  const create = useLinkSupplier(productId);
  const update = useUpdateSupplierLink(productId);
  const pending = create.isPending || update.isPending;
  const toast = useToast();

  async function save() {
    setError(null);
    if (price !== '' && !MONEY_INPUT.test(price)) {
      setError('Enter the purchase price like 45 or 45.50');
      return;
    }
    const base = { supplierProductCode: code.trim() || null, notes: notes.trim() || null, isPreferred: preferred };
    const priceField = priceEditable ? { purchasePrice: price === '' ? null : price } : {};
    try {
      if (link) {
        await update.mutateAsync({ supplierId: link.supplierId, version: link.version, ...base, ...priceField });
      } else {
        if (!supplier) {
          setError('Choose a supplier');
          return;
        }
        await create.mutateAsync({ supplierId: supplier.id, ...base, ...(priceEditable && price !== '' ? { purchasePrice: price } : {}) });
      }
      toast({ title: link ? 'Supplier link updated' : 'Supplier linked', tone: 'success' });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog
      open
      title={link ? `Supplier: ${link.supplierName}` : 'Link a supplier'}
      onClose={onClose}
      dismissible={!pending}
      footer={
        <DialogActions>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button loading={pending} onClick={() => void save()}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      }
    >
      <div className="space-y-4">
        {!link && (
          <>
            {suggestions.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Suppliers of this brand</p>
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((s) => (
                    <Button key={s.id} size="sm" variant={supplier?.id === s.id ? 'soft' : 'outline'} onClick={() => setSupplier({ id: s.id, name: s.name, isActive: true })}>
                      <Link2 aria-hidden="true" /> {s.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <Field id="link-supplier" label="Supplier">
              <SupplierPicker id="link-supplier" value={supplier} onChange={setSupplier} noneLabel={null} />
            </Field>
          </>
        )}
        <Field id="link-code" label="Supplier’s product code (optional)">
          <Input id="link-code" value={code} maxLength={60} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field id="link-notes" label="Notes (optional)">
          <Textarea id="link-notes" rows={2} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {canEditCosts && !priceEditable && (
          <p className="text-xs text-muted-foreground">To change this supplier’s purchase price, first show purchase prices on this page.</p>
        )}
        {priceEditable && (
          <Field id="link-price" label="This supplier’s purchase price (optional)" hint="Per selling unit. Visible only to people allowed to see purchase prices.">
            <MoneyInput id="link-price" className="bg-info-soft/40" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={preferred} onChange={(e) => setPreferred(e.target.checked)} />
          Preferred supplier (its price is used as the product’s purchase price)
        </label>
        {error && (
          <p role="alert" className="callout callout-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
