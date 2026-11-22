import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { useToast } from '@/components/ui/toast';
import { ProductForm } from '@/features/products/ProductForm';
import { forgetPurchasePrices, useCreateProduct, useProduct, useProductCosts, useSetDefaultCost, useUpdateProduct } from '@/features/products/products-api';
import { productTitle } from '@/features/products/product-display';
import { newIdempotencyKey } from '@/lib/ids';
import { useQueryClient } from '@tanstack/react-query';

export function NewProductPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateProduct();
  // One key per opened form: every retry of this form is the same request to the server.
  const [idempotencyKey] = useState(newIdempotencyKey);
  return (
    <Page width="medium">
      <PageHeader title="Add product" back={{ to: '/products', label: 'Products' }} />
      <ProductForm
        submitLabel="Save product"
        cancelTo="/products"
        onSubmit={async ({ input, purchasePrice }, confirmations) => {
          const product = await create.mutateAsync({
            input: { ...input, confirmations, ...(purchasePrice !== undefined ? { defaultPurchasePrice: purchasePrice } : {}) },
            idempotencyKey,
          });
          toast({ title: 'Product added', description: productTitle(product), tone: 'success' });
          navigate(`/products/${product.id}`);
        }}
      />
    </Page>
  );
}

export function EditProductPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const product = useProduct(id);
  const update = useUpdateProduct();
  const setCost = useSetDefaultCost(id);
  const [costRevealed, setCostRevealed] = useState(false);
  const costs = useProductCosts(id, costRevealed, 'form');
  // Only the cost record's VERSION is kept (never the price): a change the user kept while hiding
  // the price can still be saved after the loaded price was forgotten.
  const [costVersion, setCostVersion] = useState<number | null>(null);
  const loadedVersion = costs.isSuccess ? costs.data.version : null;
  useEffect(() => {
    if (loadedVersion !== null) setCostVersion(loadedVersion);
  }, [loadedVersion]);
  const hidePurchasePrice = useCallback(() => setCostRevealed(false), []);
  // Forget once the cost query is switched off (removing an enabled query would refetch it).
  useEffect(() => {
    if (!costRevealed) forgetPurchasePrices(queryClient);
  }, [costRevealed, queryClient]);
  // Leaving the screen: forget any loaded price.
  useEffect(() => () => forgetPurchasePrices(queryClient), [queryClient]);

  if (product.isPending) return <LoadingState label="Loading product…" skeleton="detail" />;
  if (product.isError) return <ErrorState title="Could not load this product" error={product.error} />;
  const p = product.data;

  return (
    <Page width="medium">
      <PageHeader title={`Edit ${productTitle(p)}`} back={{ to: `/products/${p.id}`, label: 'Product' }} />
      <ProductForm
        // A fresh form when another version of the product is loaded after a save.
        key={p.id}
        product={p}
        submitLabel="Save changes"
        cancelTo={`/products/${p.id}`}
        initialPurchasePrice={costRevealed && costs.isSuccess ? costs.data.defaultPurchasePrice : undefined}
        purchasePriceLoading={costs.isFetching}
        purchasePriceError={costs.isError}
        onRevealPurchasePrice={() => setCostRevealed(true)}
        onHidePurchasePrice={hidePurchasePrice}
        onSubmit={async ({ input, purchasePrice }, confirmations) => {
          const saved = await update.mutateAsync({ id: p.id, version: p.version, ...input, confirmations });
          if (purchasePrice !== undefined) {
            if (costVersion === null) throw new Error('The purchase price could not be saved: show it again and retry.');
            await setCost.mutateAsync({ defaultPurchasePrice: purchasePrice, version: costVersion });
          }
          forgetPurchasePrices(queryClient);
          toast({ title: 'Product updated', description: productTitle(saved), tone: 'success' });
          navigate(`/products/${saved.id}`);
        }}
      />
    </Page>
  );
}
