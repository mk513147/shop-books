import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/connection.js';
import { getActor, getAuth } from '../../middleware/auth.js';
import { requestContext } from '../../middleware/requestGuards.js';
import { NotFoundError } from '../../utils/errors.js';
import { parseIdempotencyKey } from '../idempotency/idempotency.js';
import { canEditPurchasePrices, PURCHASE_PRICE_CHANGE_FORBIDDEN, requirePurchasePriceAccess, requirePurchasePriceChange } from './permissions.js';
import {
  getProductCosts,
  linkSupplier,
  listSupplierLinks,
  recordPurchasePriceAccess,
  revealPurchasePrices,
  setDefaultCost,
  unlinkSupplier,
  updateSupplierLink,
} from './productCosts.service.js';
import {
  costsQuerySchema,
  costUpdateSchema,
  lookupQuerySchema,
  productCreateSchema,
  productListQuerySchema,
  productUpdateSchema,
  purchasePricesQuerySchema,
  quickSearchQuerySchema,
  similarQuerySchema,
  supplierLinkCreateSchema,
  supplierLinkUpdateSchema,
  unlinkQuerySchema,
} from './products.schemas.js';
import {
  createProduct,
  findSimilar,
  getProduct,
  getProductCostHistory,
  getProductHistory,
  listProducts,
  lookupByCode,
  quickSearch,
  purchasePriceFingerprintKey,
  supplierSuggestions,
  updateProduct,
} from './products.service.js';

function parseId(raw: unknown, what = 'Product'): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw new NotFoundError(`${what} not found`);
  return parsed.data;
}

/**
 * Product catalogue (owner and managers; mounted below requirePasswordCurrent).
 *
 * Ordinary routes NEVER return purchase prices. Routes marked [see] are behind
 * requirePurchasePriceAccess (owner, or a manager allowed to SEE prices) and every successful read
 * is recorded in auth_events (purchase_prices_viewed; no amounts). Routes marked [change] need the
 * CHANGE permission too. Supplier-link writes that would alter or delete a stored price or move
 * the effective price need CHANGE as well (checked in productCosts.service.ts).
 *
 *   GET    /                         list / search / filter / sort / paginate
 *   GET    /quick-search?q&limit     fast type-ahead (active products, no count)
 *   GET    /lookup?code=             exact barcode or SKU
 *   GET    /similar?name&brandId...  possible duplicates for the form
 *   GET    /purchase-prices?ids=     [see] reveal one page (≤ 100 ids)
 *   POST   /                         create (Idempotency-Key; defaultPurchasePrice needs [change])
 *   GET    /:id                      detail
 *   PATCH  /:id                      edit / deactivate / reactivate (+ version, confirmations)
 *   GET    /:id/history              product + supplier-link history (never purchase prices)
 *   GET    /:id/cost-history         [see] purchase-price history
 *   GET    /:id/costs?scope=         [see] default + supplier prices, effective price, warnings
 *   PUT    /:id/costs                [change] set / clear the default purchase price (+ version)
 *   GET    /:id/suppliers            linked suppliers (never with prices: see GET /:id/costs)
 *   GET    /:id/supplier-suggestions active suppliers of the product's brand, not yet linked
 *   POST   /:id/suppliers            link (purchasePrice, or taking "preferred" from a priced link: [change])
 *   PATCH  /:id/suppliers/:sid       update link / preferred (+ version; price-affecting: [change])
 *   DELETE /:id/suppliers/:sid?version=  unlink (+ version; a link holding a price: [change])
 */
export function createProductsRouter({ db, sessionSecret }: { db: Database; sessionSecret: string }): Router {
  const router = Router();
  const priceKey = purchasePriceFingerprintKey(sessionSecret);

  router.get('/', async (req, res) => {
    res.json(await listProducts(db, productListQuerySchema.parse(req.query)));
  });

  router.get('/quick-search', async (req, res) => {
    const { q, limit } = quickSearchQuerySchema.parse(req.query);
    res.json(await quickSearch(db, q, limit));
  });

  router.get('/lookup', async (req, res) => {
    const { code } = lookupQuerySchema.parse(req.query);
    res.json({ products: await lookupByCode(db, code) });
  });

  router.get('/similar', async (req, res) => {
    res.json({ similar: await findSimilar(db, similarQuerySchema.parse(req.query)) });
  });

  router.get('/purchase-prices', requirePurchasePriceAccess, async (req, res) => {
    const { ids, scope } = purchasePricesQuerySchema.parse(req.query);
    res.json({ prices: await revealPurchasePrices(db, ids, scope, getAuth(res).user.id, requestContext(req)) });
  });

  router.post('/', async (req, res) => {
    const key = parseIdempotencyKey(req.get('Idempotency-Key'));
    const input = productCreateSchema.parse(req.body);
    if (input.defaultPurchasePrice !== undefined && !canEditPurchasePrices(res)) throw PURCHASE_PRICE_CHANGE_FORBIDDEN();
    const result = await createProduct(db, input, getActor(res), key, priceKey);
    if (result.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  });

  router.get('/:id', async (req, res) => {
    res.json({ product: await getProduct(db, parseId(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const { version, confirmations, ...changes } = productUpdateSchema.parse(req.body);
    res.json({ product: await updateProduct(db, parseId(req.params.id), changes, confirmations ?? [], version, getActor(res)) });
  });

  router.get('/:id/history', async (req, res) => {
    res.json({ history: await getProductHistory(db, parseId(req.params.id)) });
  });

  router.get('/:id/cost-history', requirePurchasePriceAccess, async (req, res) => {
    const id = parseId(req.params.id);
    const history = await getProductCostHistory(db, id);
    await recordPurchasePriceAccess(db, requestContext(req), getAuth(res).user.id, 'history', [id]);
    res.json({ history });
  });

  router.get('/:id/costs', requirePurchasePriceAccess, async (req, res) => {
    const id = parseId(req.params.id);
    const { scope } = costsQuerySchema.parse(req.query);
    const costs = await getProductCosts(db, id);
    await recordPurchasePriceAccess(db, requestContext(req), getAuth(res).user.id, scope, [id]);
    res.json({ costs });
  });

  router.put('/:id/costs', requirePurchasePriceChange, async (req, res) => {
    const id = parseId(req.params.id);
    const { defaultPurchasePrice, version } = costUpdateSchema.parse(req.body);
    const costs = await setDefaultCost(db, id, defaultPurchasePrice, version, getActor(res));
    // The response carries every price of the product: recorded like any other read.
    await recordPurchasePriceAccess(db, requestContext(req), getAuth(res).user.id, 'after_change', [id]);
    res.json({ costs });
  });

  router.get('/:id/suppliers', async (req, res) => {
    // Never with prices, not even for permitted users: in the browser this list is ordinary cached
    // product data. Supplier prices are read only through GET /:id/costs (protected, revealed on demand).
    res.json({ suppliers: await listSupplierLinks(db, parseId(req.params.id)) });
  });

  router.get('/:id/supplier-suggestions', async (req, res) => {
    res.json({ suppliers: await supplierSuggestions(db, parseId(req.params.id)) });
  });

  router.post('/:id/suppliers', async (req, res) => {
    const input = supplierLinkCreateSchema.parse(req.body);
    res.status(201).json({ link: await linkSupplier(db, parseId(req.params.id), input, getActor(res), canEditPurchasePrices(res)) });
  });

  router.patch('/:id/suppliers/:supplierId', async (req, res) => {
    const { version, ...changes } = supplierLinkUpdateSchema.parse(req.body);
    const link = await updateSupplierLink(
      db,
      parseId(req.params.id),
      parseId(req.params.supplierId, 'Supplier'),
      changes,
      version,
      getActor(res),
      canEditPurchasePrices(res),
    );
    res.json({ link });
  });

  router.delete('/:id/suppliers/:supplierId', async (req, res) => {
    const { version } = unlinkQuerySchema.parse(req.query);
    await unlinkSupplier(db, parseId(req.params.id), parseId(req.params.supplierId, 'Supplier'), version, getActor(res), canEditPurchasePrices(res));
    res.status(204).end();
  });

  return router;
}
