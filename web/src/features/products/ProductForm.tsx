import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, Eye, EyeOff, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { MoneyInput } from '@/components/finance/MoneyInput';
import { errorMessage } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { errorProps, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/search-select';
import { Select, Textarea } from '@/components/ui/select';
import { useAuth } from '@/features/auth/auth-context';
import { useBrands } from '@/features/brands/brands-api';
import { useCategories } from '@/features/categories/categories-api';
import { useBrandCreator } from '@/features/classification/useOptionCreators';
import { ApiError } from '@/lib/api-client';
import { formatInr, MONEY_INPUT, toPaise } from '@/lib/money';
import type { Product, ProductInput, SellingUnit } from '@/types/api';
import { productTitle, UNIT_LABELS } from './product-display';
import { useDebouncedValue, useSimilarProducts } from './products-api';

const optionalInt = (max: number, label: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= max), `${label}: a whole number from 1 to ${max}`);

const money = (required: boolean, label: string) =>
  z
    .string()
    .trim()
    .refine((v) => (required ? v !== '' : true), `Enter the ${label}`)
    .refine((v) => v === '' || MONEY_INPUT.test(v), 'Enter an amount like 45 or 45.50')
    .refine((v) => v === '' || label === 'purchase price' || toPaise(v) > 0n, 'Must be more than 0');

// Mirrors the server rules for fast feedback; the server re-validates everything.
const schema = z
  .object({
    name: z.string().trim().min(1, 'Enter the product name').max(160, 'At most 160 characters'),
    brandId: z.string(),
    categoryId: z.string().min(1, 'Choose a category'),
    description: z.string().trim().max(1000, 'At most 1000 characters'),
    size: z.string().trim().max(20, 'At most 20 characters'),
    pageCount: optionalInt(10_000, 'Pages'),
    gsm: optionalInt(2000, 'GSM'),
    binding: z.string().trim().max(40, 'At most 40 characters'),
    sellingUnit: z.enum(['piece', 'pack', 'box', 'set', 'ream']),
    packQty: z.string().trim().refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 100_000, 'A whole number from 1'),
    attributes: z.array(z.object({ key: z.string().trim(), value: z.string().trim().max(80, 'At most 80 characters') })),
    aliases: z.string().trim().max(1200),
    mrp: money(false, 'MRP'),
    sellingPrice: money(true, 'selling price'),
    purchasePrice: money(false, 'purchase price'),
    sku: z.string().trim().refine((v) => v === '' || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/.test(v), '1–40 letters, digits, ".", "_", "/" or "-"'),
    barcode: z.string().trim().refine((v) => v === '' || /^[A-Za-z0-9-]{4,64}$/.test(v), '4–64 letters, digits or "-"'),
  })
  .refine((v) => v.sellingUnit !== 'piece' || v.packQty === '1', { path: ['packQty'], message: 'A product sold by the piece has a pack quantity of 1' })
  .refine((v) => v.attributes.every((a) => (a.key === '' && a.value === '') || /^[a-z][a-z0-9_]{0,30}$/.test(a.key.toLowerCase().replace(/\s+/g, '_'))), {
    path: ['attributes'],
    message: 'Detail names: letters, digits and spaces',
  });
type Values = z.infer<typeof schema>;

export interface ProductFormResult {
  input: ProductInput;
  /** Only when the user may see purchase prices and entered/changed one; undefined = untouched. */
  purchasePrice?: string | null;
}

const DETAIL_SUGGESTIONS = ['ruling', 'colour', 'material', 'tip size', 'ink colour'];
const SIZE_SUGGESTIONS = ['A3', 'A4', 'A5', 'A6'];
const BINDING_SUGGESTIONS = ['spiral', 'register', 'pad', 'hardbound', 'stapled', 'perfect bound'];

function toValues(p: Product | undefined): Values {
  return {
    name: p?.name ?? '',
    brandId: p?.brand?.id ?? '',
    categoryId: p?.category.id ?? '',
    description: p?.description ?? '',
    size: p?.size ?? '',
    pageCount: p?.pageCount ? String(p.pageCount) : '',
    gsm: p?.gsm ? String(p.gsm) : '',
    binding: p?.binding ?? '',
    sellingUnit: p?.sellingUnit ?? 'piece',
    packQty: String(p?.packQty ?? 1),
    attributes: Object.entries(p?.attributes ?? {}).map(([key, value]) => ({ key: key.replace(/_/g, ' '), value: String(value) })),
    aliases: (p?.searchAliases ?? []).join(', '),
    mrp: p?.mrp ?? '',
    sellingPrice: p?.sellingPrice ?? '',
    purchasePrice: '',
    sku: p?.sku ?? '',
    barcode: p?.barcode ?? '',
  };
}

function toInput(v: Values): ProductInput {
  return {
    name: v.name,
    brandId: v.brandId || null,
    categoryId: v.categoryId,
    description: v.description || null,
    size: v.size || null,
    pageCount: v.pageCount ? Number(v.pageCount) : null,
    gsm: v.gsm ? Number(v.gsm) : null,
    binding: v.binding || null,
    sellingUnit: v.sellingUnit as SellingUnit,
    packQty: Number(v.packQty),
    attributes: Object.fromEntries(
      v.attributes.filter((a) => a.key && a.value).map((a) => [a.key.toLowerCase().trim().replace(/\s+/g, '_'), a.value]),
    ),
    searchAliases: v.aliases
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    mrp: v.mrp || null,
    sellingPrice: v.sellingPrice,
    sku: v.sku || null,
    barcode: v.barcode || null,
  };
}

const spAboveMrp = (sp: string, mrp: string) => MONEY_INPUT.test(sp) && MONEY_INPUT.test(mrp) && toPaise(sp) > toPaise(mrp);

/**
 * Add / edit a product. Sections: basics, specifications, prices, codes & aliases. A selling price
 * above the MRP needs an explicit confirmation (the server enforces it too). Typed values stay on
 * failure.
 *
 * Purchase price (only for users allowed to SEE it; editable only with the CHANGE permission) is
 * hidden until the eye is pressed:
 *  - hiding an UNCHANGED price clears it from the form and from memory;
 *  - hiding a CHANGED price never silently drops the change: the user chooses "hide and keep my
 *    change" (masked; saved with the product) or "discard my change";
 *  - the tab going to the background hides it the same way (a change is kept, masked);
 *  - a manager who may see but not change prices gets a read-only value.
 */
export function ProductForm({
  product,
  initialPurchasePrice,
  purchasePriceLoading = false,
  purchasePriceError = false,
  onRevealPurchasePrice,
  onHidePurchasePrice,
  submitLabel,
  cancelTo,
  onSubmit,
}: {
  product?: Product;
  /** Current default purchase price (edit form, after the user revealed it). */
  initialPurchasePrice?: string | null | undefined;
  purchasePriceLoading?: boolean;
  /** The stored purchase price could not be loaded (e.g. permission revoked): hide again. */
  purchasePriceError?: boolean;
  /** Edit form: load the stored purchase price when the user reveals it. */
  onRevealPurchasePrice?: () => void;
  /** The price was hidden: the page forgets the loaded price (never kept in memory while hidden). */
  onHidePurchasePrice?: () => void;
  submitLabel: string;
  cancelTo: string;
  onSubmit: (result: ProductFormResult, confirmations: 'sp_above_mrp'[]) => Promise<void>;
}) {
  const { user } = useAuth();
  const canSeeCosts = user?.canViewPurchasePrices === true;
  const canEditCosts = canSeeCosts && user?.canEditPurchasePrices === true;
  const brands = useBrands('all');
  const categories = useCategories('all');
  const brandCreator = useBrandCreator();
  const [newBrand, setNewBrand] = useState<string | null>(null);
  const [costVisible, setCostVisible] = useState(false);
  /** A changed purchase price the user chose to keep while hiding it (saved with the product). */
  const [hasPendingCost, setHasPendingCost] = useState(false);
  const [askHideCost, setAskHideCost] = useState(false);
  const [costLoadFailed, setCostLoadFailed] = useState(false);
  const [confirmAboveMrp, setConfirmAboveMrp] = useState<Values | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    control,
    getValues,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: toValues(product),
  });
  const watched = useWatch({ control });
  const attributes = watched.attributes ?? [];

  // The stored purchase price arrives after "reveal" on the edit form: fill it in once.
  const filledCost = useRef(false);
  if (canEditCosts && costVisible && initialPurchasePrice !== undefined && !filledCost.current) {
    filledCost.current = true;
    if (getValues('purchasePrice') === '') setValue('purchasePrice', initialPurchasePrice ?? '');
  }

  const typedCost = watched.purchasePrice ?? '';
  const costBaseline = product ? (initialPurchasePrice ?? '') : '';
  const costChanged = canEditCosts && (hasPendingCost || (costVisible && typedCost !== costBaseline));

  /** Hide and forget: the value leaves the form and the loaded price leaves memory. */
  const forgetCost = useCallback(() => {
    setValue('purchasePrice', '');
    filledCost.current = false;
    setCostVisible(false);
    setHasPendingCost(false);
    setAskHideCost(false);
    onHidePurchasePrice?.();
  }, [setValue, onHidePurchasePrice]);

  /** Hide but keep the user's change (masked) so it is saved with the product. */
  const keepCostChangeHidden = useCallback(() => {
    setCostVisible(false);
    setHasPendingCost(true);
    setAskHideCost(false);
    onHidePurchasePrice?.();
  }, [onHidePurchasePrice]);

  // Tab in the background: hide (an unsaved change is kept, masked; never dropped).
  const changedRef = useRef(costChanged);
  changedRef.current = costChanged;
  const visibleRef = useRef(costVisible);
  visibleRef.current = costVisible;
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden' || !visibleRef.current) return;
      if (changedRef.current) keepCostChangeHidden();
      else forgetCost();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [forgetCost, keepCostChangeHidden]);

  // Loading failed (connection, or the permission was revoked): hide, nothing stale stays visible.
  useEffect(() => {
    if (purchasePriceError && costVisible) {
      setCostLoadFailed(true);
      if (changedRef.current) keepCostChangeHidden();
      else forgetCost();
    }
  }, [purchasePriceError, costVisible, forgetCost, keepCostChangeHidden]);

  const brandOptions: SearchSelectOption[] = useMemo(
    () => (brands.data ?? []).filter((b) => b.isActive || b.id === product?.brand?.id).map((b) => ({ id: b.id, name: b.name, isActive: b.isActive })),
    [brands.data, product?.brand?.id],
  );
  const selectedBrand = brandOptions.find((b) => b.id === watched.brandId) ?? null;
  const categoryOptions = (categories.data ?? []).filter((c) => (c.isActive && c.isProductUsable) || c.id === product?.category.id);
  const noUsableCategories = categories.isSuccess && !categories.data.some((c) => c.isActive && c.isProductUsable);

  const debouncedName = useDebouncedValue(watched.name ?? '', 400);
  const similar = useSimilarProducts({
    name: debouncedName,
    brandId: watched.brandId || null,
    size: watched.size ?? '',
    pageCount: watched.pageCount ?? '',
    gsm: watched.gsm ?? '',
    binding: watched.binding ?? '',
    excludeId: product?.id,
  });

  const sp = watched.sellingPrice ?? '';
  const mrp = watched.mrp ?? '';
  const cost = typedCost;
  const aboveMrp = spAboveMrp(sp, mrp);
  const costAboveSp = canSeeCosts && costVisible && MONEY_INPUT.test(cost) && MONEY_INPUT.test(sp) && toPaise(cost) > toPaise(sp);

  async function save(values: Values, confirmations: 'sp_above_mrp'[]) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSubmitError(null);
    try {
      const result: ProductFormResult = { input: toInput(values) };
      if (canEditCosts && (costVisible || hasPendingCost)) {
        const entered = values.purchasePrice || null;
        const changed = hasPendingCost || (product === undefined ? entered !== null : entered !== (initialPurchasePrice ?? null));
        if (changed) result.purchasePrice = entered;
      }
      await onSubmit(result, confirmations);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRICE_CONFIRMATION_REQUIRED') {
        setConfirmAboveMrp(values);
      } else {
        for (const d of err instanceof ApiError ? (err.details ?? []) : []) {
          if (d.path in values) setError(d.path as keyof Values, { message: d.message });
        }
        setSubmitError(err);
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={handleSubmit((values) => {
        if (spAboveMrp(values.sellingPrice, values.mrp)) setConfirmAboveMrp(values);
        else void save(values, []);
      })}
    >
      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field id="product-name" label="Product name (without the brand)" error={errors.name?.message} hint="For example “Spiral Notebook” or “Register”." className="md:col-span-2">
            <Input id="product-name" autoComplete="off" autoFocus={!product} {...errorProps('product-name', errors.name)} {...register('name')} />
          </Field>
          <div className="space-y-1.5">
            <label htmlFor="product-brand" className="text-sm font-medium">
              Brand (optional)
            </label>
            <SearchSelect
              id="product-brand"
              noun="brand"
              options={brandOptions}
              value={selectedBrand}
              onChange={(o) => setValue('brandId', o?.id ?? '', { shouldDirty: true })}
              placeholder="No brand"
              noneLabel="No brand"
              loading={brands.isPending}
            />
            {newBrand === null ? (
              <button type="button" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" onClick={() => setNewBrand('')}>
                <Plus className="size-3.5" aria-hidden="true" /> New brand
              </button>
            ) : (
              <div className="flex gap-2">
                <Input aria-label="New brand name" placeholder="Brand name" value={newBrand} onChange={(e) => setNewBrand(e.target.value)} />
                <Button
                  type="button"
                  variant="outline"
                  loading={brandCreator.creating}
                  disabled={!newBrand.trim()}
                  onClick={async () => {
                    const created = await brandCreator.create(newBrand.trim());
                    if (created) {
                      setValue('brandId', created.id, { shouldDirty: true });
                      setNewBrand(null);
                    }
                  }}
                >
                  Add
                </Button>
                <Button type="button" variant="ghost" aria-label="Cancel new brand" onClick={() => setNewBrand(null)}>
                  <X aria-hidden="true" />
                </Button>
              </div>
            )}
            {brandCreator.note && <p className={brandCreator.note.error ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}>{brandCreator.note.text}</p>}
          </div>
          <Field id="product-category" label="Category" error={errors.categoryId?.message}>
            <Select id="product-category" {...errorProps('product-category', errors.categoryId)} {...register('categoryId')}>
              <option value="">Choose a category</option>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {!c.isActive ? ' (archived)' : !c.isProductUsable ? ' (not for products)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          {noUsableCategories && (
            <p className="callout callout-warning md:col-span-2">
              No category is marked for products yet. Open <Link to="/categories" className="font-medium underline">Categories</Link> and switch on “Use for
              products” for the categories you sell.
            </p>
          )}
          <Field id="product-description" label="Description (optional)" error={errors.description?.message} className="md:col-span-2">
            <Textarea id="product-description" rows={2} {...register('description')} />
          </Field>
          {similar.data && similar.data.length > 0 && (
            <div role="status" className="callout callout-warning space-y-1 md:col-span-2" data-testid="similar-products">
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-4" aria-hidden="true" />
                {similar.data.some((s) => s.sameSpecs) ? 'This product may already exist' : 'Similar products exist'}
              </p>
              <ul className="list-disc pl-5 text-sm">
                {similar.data.map((s) => (
                  <li key={s.product.id}>
                    <Link to={`/products/${s.product.id}`} className="underline" target="_blank" rel="noreferrer">
                      {productTitle(s.product)}
                    </Link>
                    {[s.product.size, s.product.pageCount ? `${s.product.pageCount} pages` : null].filter(Boolean).length > 0 &&
                      ` · ${[s.product.size, s.product.pageCount ? `${s.product.pageCount} pages` : null].filter(Boolean).join(' · ')}`}
                    {s.sameSpecs && <strong> (same details)</strong>}
                  </li>
                ))}
              </ul>
              <p className="text-xs">Save anyway only if this is a different item (for example another colour or ruling).</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Specifications</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          <Field id="product-size" label="Size" error={errors.size?.message}>
            <Input id="product-size" list="product-size-options" autoComplete="off" {...register('size')} />
            <datalist id="product-size-options">
              {SIZE_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field id="product-pages" label="Pages" error={errors.pageCount?.message}>
            <Input id="product-pages" inputMode="numeric" autoComplete="off" {...errorProps('product-pages', errors.pageCount)} {...register('pageCount')} />
          </Field>
          <Field id="product-gsm" label="GSM (paper weight)" error={errors.gsm?.message}>
            <Input id="product-gsm" inputMode="numeric" autoComplete="off" {...errorProps('product-gsm', errors.gsm)} {...register('gsm')} />
          </Field>
          <Field id="product-binding" label="Binding" error={errors.binding?.message}>
            <Input id="product-binding" list="product-binding-options" autoComplete="off" {...register('binding')} />
            <datalist id="product-binding-options">
              {BINDING_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field id="product-unit" label="Sold by the" error={errors.sellingUnit?.message}>
            <Select
              id="product-unit"
              {...register('sellingUnit', {
                onChange: (e) => {
                  if (e.target.value === 'piece') setValue('packQty', '1');
                },
              })}
            >
              {Object.entries(UNIT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="product-pack" label="Pieces in it" error={errors.packQty?.message} hint="Prices are for one selling unit.">
            <Input id="product-pack" inputMode="numeric" disabled={watched.sellingUnit === 'piece'} {...errorProps('product-pack', errors.packQty)} {...register('packQty')} />
          </Field>
          <div className="space-y-2 sm:col-span-2 md:col-span-4">
            <p className="text-sm font-medium">More details (optional)</p>
            {attributes.map((_, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input aria-label={`Detail ${i + 1} name`} placeholder="e.g. ruling" list="product-detail-names" {...register(`attributes.${i}.key` as const)} />
                <Input aria-label={`Detail ${i + 1} value`} placeholder="e.g. Single line" {...register(`attributes.${i}.value` as const)} />
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remove detail ${i + 1}`}
                  onClick={() =>
                    setValue(
                      'attributes',
                      getValues('attributes').filter((__, j) => j !== i),
                      { shouldDirty: true },
                    )
                  }
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            ))}
            <datalist id="product-detail-names">
              {DETAIL_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {errors.attributes && <p className="text-sm text-destructive">{errors.attributes.message ?? 'Check the details'}</p>}
            {attributes.length < 20 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setValue('attributes', [...getValues('attributes'), { key: '', value: '' }], { shouldDirty: true })}>
                <Plus aria-hidden="true" /> Add a detail
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Prices</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          <Field id="product-sp" label="Selling price" error={errors.sellingPrice?.message}>
            <MoneyInput id="product-sp" large {...errorProps('product-sp', errors.sellingPrice)} {...register('sellingPrice')} />
          </Field>
          <Field id="product-mrp" label="MRP (optional)" error={errors.mrp?.message}>
            <MoneyInput id="product-mrp" {...errorProps('product-mrp', errors.mrp)} {...register('mrp')} />
          </Field>
          {canSeeCosts && (product !== undefined || canEditCosts) && (
            <div className="space-y-1.5" data-testid="purchase-price-field">
              <label htmlFor="product-cost" className="text-sm font-medium">
                Default purchase price (optional)
              </label>
              {costVisible && canEditCosts ? (
                <div className="flex gap-2">
                  <MoneyInput id="product-cost" className="bg-info-soft/40" {...errorProps('product-cost', errors.purchasePrice)} {...register('purchasePrice')} />
                  <Button type="button" variant="ghost" aria-label="Hide purchase price" onClick={() => (costChanged ? setAskHideCost(true) : forgetCost())}>
                    <EyeOff aria-hidden="true" />
                  </Button>
                </div>
              ) : costVisible ? (
                <div className="flex items-center gap-2">
                  <p className="figure flex-1 rounded-lg border bg-info-soft/40 px-3 py-2" data-testid="form-cost-readonly">
                    {purchasePriceLoading || initialPurchasePrice === undefined ? '…' : initialPurchasePrice === null ? 'Not set' : formatInr(initialPurchasePrice)}
                  </p>
                  <Button type="button" variant="ghost" aria-label="Hide purchase price" onClick={forgetCost}>
                    <EyeOff aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => {
                    setCostLoadFailed(false);
                    // A kept change is shown again as typed (the stored price must not overwrite it).
                    if (hasPendingCost) filledCost.current = true;
                    setCostVisible(true);
                    onRevealPurchasePrice?.();
                  }}
                >
                  <Eye aria-hidden="true" /> {hasPendingCost ? 'Show my new purchase price' : product ? 'Show purchase price' : 'Enter purchase price'}
                </Button>
              )}
              {!canEditCosts && product !== undefined && <p className="text-xs text-muted-foreground">You can see but not change purchase prices.</p>}
              {askHideCost && (
                <div role="group" aria-label="Unsaved purchase price" className="callout callout-warning space-y-2">
                  <p className="text-sm">You changed the purchase price. Hiding it does not save or discard the change.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={keepCostChangeHidden}>
                      Hide and keep my change
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={forgetCost}>
                      Discard my change
                    </Button>
                  </div>
                </div>
              )}
              {!costVisible && hasPendingCost && (
                <div role="status" className="callout callout-info flex flex-wrap items-center gap-2 text-sm" data-testid="pending-cost">
                  <span className="flex-1">New purchase price (hidden) will be saved with the product.</span>
                  <Button type="button" size="sm" variant="outline" onClick={forgetCost}>
                    Discard my change
                  </Button>
                </div>
              )}
              {costVisible && purchasePriceLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
              {costLoadFailed && <p className="text-sm text-destructive">Could not load the purchase price. Check the connection and try again.</p>}
              {errors.purchasePrice && <p className="text-sm text-destructive">{errors.purchasePrice.message}</p>}
            </div>
          )}
          {aboveMrp && (
            <p role="status" className="callout callout-warning sm:col-span-2 md:col-span-3">
              The selling price {formatInr(sp)} is above the MRP {formatInr(mrp)}. You will be asked to confirm before saving.
            </p>
          )}
          {costAboveSp && (
            <p role="status" className="callout callout-warning sm:col-span-2 md:col-span-3">
              The purchase price is above the selling price: this product would be sold at a loss.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Codes and search words</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field id="product-sku" label="SKU / item code (optional)" error={errors.sku?.message}>
            <Input id="product-sku" autoComplete="off" {...errorProps('product-sku', errors.sku)} {...register('sku')} />
          </Field>
          <Field id="product-barcode" label="Barcode (optional)" error={errors.barcode?.message}>
            <Input id="product-barcode" inputMode="numeric" autoComplete="off" {...errorProps('product-barcode', errors.barcode)} {...register('barcode')} />
          </Field>
          <Field id="product-aliases" label="Other names people search for (optional)" hint="Separate with commas, e.g. copy, long book" className="md:col-span-2">
            <Input id="product-aliases" autoComplete="off" {...register('aliases')} />
          </Field>
        </CardContent>
      </Card>

      {submitError !== null && (
        <div role="alert" className="callout callout-danger space-y-1">
          <p>{errorMessage(submitError)}</p>
          {submitError instanceof ApiError && submitError.code === 'VERSION_CONFLICT' && (
            <p className="text-muted-foreground">Someone else changed this product. Your typed values are kept; reload the page to see their changes, then edit again.</p>
          )}
        </div>
      )}

      <div className="action-dock flex justify-end gap-2" data-action-dock>
        <Link to={cancelTo} className={buttonVariants({ variant: 'outline' })} aria-disabled={saving}>
          Cancel
        </Link>
        <Button type="submit" loading={saving}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </div>

      <Dialog
        open={confirmAboveMrp !== null}
        title="Sell above the MRP?"
        onClose={() => setConfirmAboveMrp(null)}
        size="sm"
        footer={
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirmAboveMrp(null)}>
              Go back
            </Button>
            <Button
              onClick={() => {
                const values = confirmAboveMrp;
                setConfirmAboveMrp(null);
                if (values) void save(values, ['sp_above_mrp']);
              }}
            >
              Confirm and save
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">
          The selling price {confirmAboveMrp ? formatInr(confirmAboveMrp.sellingPrice || '0') : ''} is above the MRP{' '}
          {confirmAboveMrp?.mrp ? formatInr(confirmAboveMrp.mrp) : ''}. Save it only if this is correct. Your confirmation is recorded with your name and the time.
        </p>
      </Dialog>
    </form>
  );
}
