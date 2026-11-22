# Product catalogue

Status: implemented and hardened after an independent security audit (migrations `0015_products`, `0016_product_search_words`, `0017_product_catalogue_hardening`); awaiting an independent re-audit, the owner's manual testing and production rollout (see [Production rollout](#production-rollout)). **Catalogue only:** there are no stock quantities, stock movements, purchase orders, sales, billing, refunds or reorder levels.

**Products are added and maintained by hand** on the Products screen. **Excel import is postponed** (product decision): it is not available in this release, see [Excel import: postponed](#excel-import-postponed).

Code: `server/src/modules/products/`, `web/src/features/products/`, `web/src/features/shortcuts/`, pages `web/src/routes/Product{s,Detail,Form}Page.tsx`. Retained but **not connected** to the running application: `server/src/modules/productImports/` (except `postponed.ts`), `web/src/features/productImports/`, `web/src/routes/ProductImportPage.tsx`.

## Business rules (approved)

| Rule | Implementation |
|---|---|
| One product = one independently sellable unit | One `products` row per sellable item. A pad sold whole *and* as loose sheets is two products. |
| Prices are per selling unit | `selling_unit` (piece, pack, box, set, ream) + `pack_qty` (pieces in it). MRP, selling price and purchase prices are all for **one** selling unit. |
| Name excludes the brand | `name` is e.g. "Spiral Notebook"; the brand is `brand_id`. Displayed as "Classmate Spiral Notebook". |
| Brand, SKU, barcode optional | Nullable columns. SKU and barcode are unique **among active products, ignoring letter case** (barcode case-insensitivity since 0017). Both are stored exactly as typed after trimming spaces; lookups ignore case. |
| Category mandatory, reused | `category_id` → `expense_categories`, must be active and marked **Use for products** when chosen. |
| `is_product_usable` defaults to false | Existing categories are not product categories until someone switches them on (Categories page). Expense and customer-due category pickers ignore the flag. |
| Selling price mandatory, > 0; MRP optional, > 0 | Database CHECKs + Zod. "No MRP" is `NULL`, never 0. |
| SP above MRP: warning + explicit confirmation | The API answers **422 `PRICE_CONFIRMATION_REQUIRED`** unless the request carries `confirmations: ["sp_above_mrp"]`; the product stores **who confirmed and when** (`sp_above_mrp_confirmed_by/at`). A database CHECK refuses SP > MRP without a recorded confirmation. A later price change needs a fresh confirmation; bringing SP to MRP or below clears it. |
| Purchase price > SP | Warning only (and only to users who may see purchase prices). Nothing is changed automatically. |
| Deactivate, never delete | `products_no_delete` trigger. Reactivation reports a SKU/barcode clash as 409 `SKU_TAKEN` / `BARCODE_TAKEN`. |
| Multiple suppliers per product | `product_suppliers` (supplier price, supplier's product code, notes, one **preferred**). An archived supplier cannot be linked or made preferred. |
| Archiving a preferred supplier | A supplier that is the **preferred supplier of any product** (active or inactive) **cannot be archived or reactivated**: 409 `SUPPLIER_IS_PREFERRED`, naming up to three products (never a price). Otherwise archiving would silently switch those products' effective purchase price without the *change* permission. The user first chooses another preferred supplier, or none, on each product — an explicit, audited link change under the purchase-price rules (taking "preferred" off a link that holds a price needs *change*). Same rule for the owner and every manager. Enforced in `suppliers.service.ts` with the supplier row locked; every path that makes a link preferred locks the supplier row `FOR SHARE` and re-checks it is active, so concurrent requests cannot produce an archived preferred supplier. Other supplier edits (name, phone…) are unaffected. |
| Effective purchase price | Preferred supplier's price when that supplier is **active** and has a price; otherwise the default purchase price (`product_costs`); otherwise none. Changing the preferred supplier only moves the flag; stored prices are never overwritten. |
| Purchase-price access | **Two separate permissions** (Users page, owner only): **Can view purchase prices** and **Can change purchase prices** (needs view). The owner always has both. Effective on the manager's next request; no sign-out. |
| Product entry | Manual only in this release (Excel import postponed). |
| Keyboard shortcuts | F2 (Add expense), F4 (product quick lookup), Esc (close dialog). Desktop only. |

## Schema

```
users.can_view_purchase_prices ──┐  (owner: both always allowed, in code)
users.can_edit_purchase_prices ──┘  CHECK: edit ⇒ view (0017)
brands (0..1) ─┐
expense_categories (1) + is_product_usable ─┤
                                             ▼
products ──1:1── product_search  (trigger-maintained search documents; pg_trgm GIN)
   │ └──0..1── product_costs     (default purchase price; PROTECTED)
   └──< product_suppliers >── suppliers   (supplier purchase price PROTECTED; one preferred)
product_search_words              (vocabulary for typo tolerance; 0016)
product_import_batches ──< product_import_rows   (POSTPONED feature: tables kept, unreachable)
financial_audit_events: product | product_cost | product_import
```

`products` columns: `id, name, brand_id, category_id, sku, barcode, description, size, page_count, gsm, binding, selling_unit, pack_qty, attributes (jsonb object ≤ 4 KB), search_aliases (text[] ≤ 20), mrp, selling_price, sp_above_mrp_confirmed_at/by, is_active, version, created_at/by, updated_at/by`. Every rule is a named CHECK (see `0015_products.sql`); sizes are stored as written in upper case and never interpreted ("A4", "SL", "MD").

Indexes: `products(brand_id)`, `products(category_id)`, unique `lower(sku)` and unique `lower(barcode)` among active products, `lower(barcode)` and `lower(sku)` lookup indexes (all products); GIN `gin_trgm_ops` on `product_search.document` and `.supplier_document` and on `product_search_words.word`; `product_suppliers(supplier_id)`; unique `(product_id) WHERE is_preferred`.

Triggers: `set_updated_at` and no-delete guards; search refresh on product changes, on brand / category / supplier **renames** and on supplier link changes. Search refresh writes only `product_search` (and adds words to `product_search_words`), never `products`, so it changes no timestamp, version or audit history.

**Search refresh under concurrency (0017).** Every refresh first takes one transaction-scoped advisory lock (`product_search_lock()`, key `726001003`) and only then reads, with a fresh snapshot (PL/pgSQL at READ COMMITTED, the application's isolation level). A product edit racing a brand / category / supplier rename therefore always ends with a document that contains both changes, whichever commits first; the rename triggers take the lock *before* choosing which products to refresh, so a product moved to the renamed brand concurrently is not missed. Refreshes are serialised, so their upserts can no longer deadlock against each other. Cost: product-catalogue writes are serialised for the rest of their short transaction (search reads take no lock).

**Database locale requirement.** `product_search_norm` uses `lower()` and `[[:alnum:]]`, which follow the database's character classification. On a Unicode-aware locale (e.g. `C.UTF-8`, `en_US.UTF-8`, or PostgreSQL's built-in `C.UTF-8`) the API's normaliser and the database agree for all scripts; on plain `C`/`POSIX` non-ASCII letters (é, Devanagari…) are dropped from documents and such names cannot be found. Verified: the parity test fails on a plain `C` cluster and passes on built-in `C.UTF-8`. Check production before rollout (step 1 below).

## API

All under `/api/v1`, authenticated, CSRF-protected writes, Zod `strictObject` bodies, decimal-string money. **[see]** = owner or manager with *view*, otherwise **403 `PURCHASE_PRICE_FORBIDDEN`**; every successful [see] response is recorded in the access trail. **[change]** = owner or manager with *view + change*, otherwise **403 `PURCHASE_PRICE_CHANGE_FORBIDDEN`** (or `PURCHASE_PRICE_FORBIDDEN` without view).

| Method and path | Purpose |
|---|---|
| `GET /products?q&brandId(&=none)&categoryId&status=active\|inactive\|all&sort=relevance\|name\|brand\|selling_price\|mrp\|updated&dir&page&pageSize≤100` | Catalogue list and search; `closeMatches: true` when only typo-tolerant matches were found |
| `GET /products/quick-search?q&limit≤20` | Type-ahead for the quick lookup (active only, no count, `hasMore`) |
| `GET /products/lookup?code=` | Exact barcode or SKU (case ignored) |
| `GET /products/similar?name&brandId&size&pageCount&gsm&binding&excludeId` | Possible duplicates for the form (`sameSpecs`) |
| `GET /products/purchase-prices?ids=a,b,…(≤100)&scope=page\|product\|form` | **[see]** Reveal the visible page |
| `POST /products` (`Idempotency-Key`) | Create; `defaultPurchasePrice` only with **[change]**; `confirmations`. A reused key with a different body **or a different purchase price** answers 409 `IDEMPOTENCY_KEY_REUSED`. |
| `GET /products/:id` · `PATCH /products/:id` (`version`, `confirmations`, `isActive`) | Detail; edit / deactivate / reactivate |
| `GET /products/:id/history` | Product + supplier-link history, **never purchase prices** (for everyone) |
| `GET /products/:id/cost-history` | **[see]** Purchase-price history (`product_cost` events) |
| `GET /products/:id/costs?scope=product\|form` | **[see]** Default + supplier prices, effective price, warnings |
| `PUT /products/:id/costs` (`defaultPurchasePrice`, `version`; 0 = none saved yet) | **[change]** Set / clear the default purchase price (the response is recorded as a read, scope `after_change`) |
| `GET /products/:id/suppliers` | Linked suppliers — **never with prices**, for anyone |
| `GET /products/:id/supplier-suggestions` | Active suppliers of the product's brand (existing `supplier_brands`), not yet linked |
| `POST /products/:id/suppliers` | Link. `purchasePrice` needs [change]; `isPreferred: true` taking the flag from a link that holds a price needs [change] |
| `PATCH /products/:id/suppliers/:supplierId` (`version`) | Update code / notes / preferred / price. Price needs [change]; moving the preferred flag to or from a link that holds a price needs [change]; an archived supplier cannot become preferred (400) |
| `DELETE /products/:id/suppliers/:supplierId?version=N` | Unlink, **optimistic**: missing version 400, stale version (or link already removed) 409 `VERSION_CONFLICT`. A link that holds a price needs [change] |
| `GET/POST/PATCH /categories` | `isProductUsable` on create/update; `?usage=products` lists only usable ones; `productCount` |
| `PATCH /users/:id {canViewPurchasePrices?, canEditPurchasePrices?}` | Owner only. 400 `OWNER_ALWAYS_HAS_ACCESS` for the owner row; 400 `EDIT_NEEDS_VIEW` for change without view; turning view off turns change off |
| `GET /auth/me` | `user.canViewPurchasePrices`, `user.canEditPurchasePrices` (effective) |
| `/product-imports/…` (every method and path) | **503 `PRODUCT_IMPORT_UNAVAILABLE`** (import postponed) |

Supplier defaults (a supplier's brands/categories) are never changed from product screens.

## Purchase-price protection

### Permission model

| | Owner | Manager: view + change | Manager: view only | Manager: neither |
|---|---|---|---|---|
| See prices (reveal, costs, cost history) | yes | yes | yes | 403 |
| Set / clear the default price | yes | yes | 403 | 403 |
| Link a supplier with a price, change a supplier price | yes | yes | 403 | 403 |
| Unlink a supplier whose link holds a price (deletes it) | yes | yes | 403 | 403 |
| Move "preferred" to / from a link that holds a price (changes the effective price) | yes | yes | 403 | 403 |
| Link / unlink / edit code & notes / move "preferred" between links **without** prices | yes | yes | yes | yes |

The supplier-link rules are enforced in `productCosts.service.ts` inside the transaction, after the rows are locked, so no route can bypass them. A refusal reveals only that a link *holds* a price, never the amount. The browser offers price editing only to users with the change permission; the server is the control.

### Where prices are kept out

| Path | How purchase prices are kept out |
|---|---|
| List, search, quick search, lookup, detail, similar | Queries never join the cost tables; responses have no cost fields. Search documents contain no prices, so searching "45" cannot reveal a cost. No sorting or filtering by cost. |
| Supplier links | Neither the list nor any link write response ever contains a price (for anyone). Supplier prices come only from `GET /:id/costs`. |
| History | `/history` returns `product` events only (MRP/SP, link details, never purchase prices). Purchase-price changes are `product_cost` events, readable only through `/cost-history` [see]. |
| Sync feed | `product` events only (no values ever); `product_cost` and `product_import` are not broadcast. |
| Idempotency records | Create responses never contain a price. The stored request hash covers the price only through an HMAC keyed by a value derived from `SESSION_SECRET`, so a reused key with another price is refused, yet the hash cannot be brute-forced back to a price. (Rotating `SESSION_SECRET` makes a retry across the rotation answer 409 instead of replaying.) |
| Errors | Price validation for costs happens only on cost routes; 403s echo nothing; "below cost" warnings are never computed for unauthorised users. |
| Server logs | Query strings are never logged. PostgreSQL errors are logged as code/constraint/table only (`loggableError`): no `detail` ("Failing row contains …", "Key (…)=(…)"), no data-exception message. |
| Import | Postponed: every route answers 503 before any body handling. |
| Browser | See below. |

### Browser lifecycle

- Prices are fetched only on **reveal**, under their own query root `['product-costs', …]` (`gcTime 0`, `staleTime 0`, no retry): page prices, one product's costs, **and purchase-price history** (the History dialog has its own "Purchase-price changes — Show" control).
- Hidden again (and removed from memory) on hide, page / filter / search / sort change, leaving the screen, the tab going to the background, closing the History dialog, a failed price request, and when the signed-in user loses the view permission. Prices are forgotten only *after* the query is switched off, so hiding never triggers a refetch.
- A **403** on any price request hides the prices, shows "You can no longer see purchase prices" and refreshes the signed-in user, so the screen stops offering prices.
- **Edit form:** hiding an unchanged price clears it from the form. Hiding a *changed* price asks: **Hide and keep my change** (masked; saved with the product) or **Discard my change** — never silently dropped. The tab going to the background hides it the same way (a change is kept masked). A view-only manager sees a read-only value. Only the cost record's *version* is kept for saving, never the loaded price.
- A save that finishes after the prices were hidden does not put them back into memory (written only into a cost query that is on screen).
- **Mutations never hold prices** (`useConfidentialMutation`): creating a product, saving the default price and every supplier-link write hand the typed price to the request through a ref that is dropped when the request starts; the mutation records only non-confidential values (e.g. the supplier id for a row's spinner), returns no prices (the cost answer goes only into the price query on screen), and leaves the cache as soon as nothing observes it (`gcTime 0`). Failed saves therefore leave no price behind either. The supplier-link dialog drops a loaded supplier price when prices are hidden while it is open.
- **Sign-out** removes every cached query **and every cached mutation**. Signing in as a **different user** on the same tab does the same.
- **Another tab changes the account** (tabs share the session cookie): every session refresh checks *who* is signed in, and if it is no longer the account whose data the tab holds — or nobody — that tab forgets every cached query and mutation *before* showing the new identity. The tab where someone signs in, signs out or changes the password announces it (`BroadcastChannel 'shop-books-session'`), so the other tabs re-read the session at once; otherwise they notice on the next focus or request. A 401 never re-announces (no refresh loop), and the same account refreshing its session keeps everything. Typed but unsaved form fields are left to the existing unsaved-work safeguards.
- Never in the URL, router state or browser storage. The service worker has **no runtime caching** (`runtimeCaching: []`) and every API response is `Cache-Control: no-store`.

### Access trail

Every successful purchase-price read — by **everyone, the owner included** — is recorded in `auth_events` as `purchase_prices_viewed` with the user, the time and `details: { scope, productCount, productIds }` where `scope` is `page`, `product`, `form`, `history` or `after_change`. **No amount is ever recorded.** The record is written after the read succeeded and before the response is sent: if it cannot be written the request fails and no prices leave the server; refused (403) or failed reads leave no "viewed" record. Permission changes are `user_updated` events with `{ canViewPurchasePrices, canEditPurchasePrices }`. There is no screen for this trail yet (owner reads it with SQL or a later report).

## Search

1. The typed text is normalised exactly like the SQL function `product_search_norm` (lower case, non-alphanumerics → spaces; parity is tested — needs a Unicode-aware database locale, see [Schema](#schema)) and split into at most 8 tokens.
2. **Every token must match** as a substring of the product's search document (brand, name, category, size, "140 pages 140p", "150gsm 150g", binding, aliases, attribute values, SKU, barcode) or of its supplier names; numeric tokens also match a barcode / SKU prefix. Each token is a separately bound `LIKE`, served by the trigram GIN index.
3. Ranking: exact barcode / SKU, case ignored (1000) › all tokens in the product's own fields (100) › brand starts with the first token (50) › exact size / pages / GSM (20 each) › word-start matches (10 each) › shorter document. Supplier-name-only matches get no product bonus, so they come last.
4. **Typo tolerance** (only when the strict search finds nothing for a list, or fewer than 5 for quick search): each word of 4+ letters is corrected against `product_search_words` (`similarity ≥ 0.4`, up to 3 corrections, e.g. "clasmate" → "classmate"), then the same indexed substring search runs with the corrections. Words are never removed from the vocabulary (a renamed product's old word simply finds nothing).

Client: quick lookup debounce **150 ms**, catalogue **250 ms** (URL updated with `replace`), Enter searches at once (barcode scanners), minimum 2 characters (1 for a digit), every request carries an `AbortSignal` (TanStack Query cancels superseded requests), `keepPreviousData` against flicker, 30 s stale time, refreshed by `product` live updates.

**Measured before 0017** (opt-in benchmark, 10,000 synthetic products, local PostgreSQL 18 on the development PC, warm cache, 200 runs of 10 realistic queries — `PRODUCT_SEARCH_BENCH=1 npx vitest run tests/products.search.bench.integration.test.ts` in `server/`): quick search p50 16 ms / p95 33 ms; catalogue list (count + page + details) p50 30 ms / p95 51 ms; typo query "clasmate" ≈ 25 ms. 0017 changes only write-side refreshes and the barcode predicate (`lower(barcode)`, indexed); the benchmark was not re-run. Hosted latency adds the network round trip (browser → Render → Neon) and is not measured here.

## Excel import: postponed

**Product decision:** Excel import is not part of this release. Products are added by hand.

What is disabled:

| Layer | State |
|---|---|
| API | `routes/index.ts` mounts `productImportsUnavailable` (`server/src/modules/productImports/postponed.ts`) at `/product-imports` **instead of** the import router, right after the Origin check and before the JSON guard, authentication and any body handling. Every method and path (upload, inspect, list, batch, rows, settings, row edits, split/unsplit, commit, discard, report) answers **503 `PRODUCT_IMPORT_UNAVAILABLE`**, for everyone. The import router, ZIP guard, workbook parser and analyser are not imported by the running server. The `application/octet-stream` exception for import uploads was removed from `requestGuards.ts`. |
| Web | No Import button (Products page), no `/products/import` routes (that URL is treated as a product id and shows "not found"), no menu or shortcut entry. The import screens are not in the production bundle. The empty catalogue says to add products one by one. |
| Retained (unconnected) | `server/src/modules/productImports/*` (`imports.routes.ts`, `imports.service.ts`, `workbook.ts`, `analyse.ts`, `zipGuard.ts`), `web/src/features/productImports/`, `web/src/routes/ProductImportPage.tsx` (+ its component test), the import tables from 0015, `server/tests/productImports.integration.test.ts` (ZIP-guard unit checks still run; the HTTP workflow suite is `describe.skip` with a note), `server/tests/productImportFixtures.ts`. |
| Tests | `server/tests/productImports.postponed.integration.test.ts`: all 13 route shapes answer 503 for the owner, also without a session; no batch or row is written; binary uploads are refused elsewhere (415). The product Playwright suite checks there is no import control and that an upload gets 503. |

**Existing import data.** Local `shop_books_test` holds one committed batch (3 rows) from the synthetic Playwright fixture; `shop_books_dev` (at 0010) has no import tables; production has never had 0015. Batches cannot be deleted (no-delete trigger; append-only design) and nothing was deleted. Stored raw cells (which may include a purchase-price column) are reachable only through the disabled routes; ordinary product APIs never read the import tables (product history shows only `importBatchId` / `sourceRow` on events of imported products, never cell contents).

### Before import can return (reactivation checklist)

All findings of the security audit that concern import must be fixed and re-audited first:

1. **Critical — ZIP guard bypass:** `zipGuard.ts` accepts a gap between the central directory and the end record; JSZip (used by ExcelJS) then shifts all offsets and reads a different directory (proven: a 52 KB file passed the guard and JSZip inflated a 50 MB part). Require `cdOffset + cdSize === eocdOffset` (no prepended data / ZIP64 locator) or hand ExcelJS only bytes the guard has inflated itself.
2. **High — ExcelJS range expansion:** `<mergeCell>` and data-validation `sqref` ranges create one object per cell on load; a tiny sheet-wide range exhausts memory. Reject large ranges in the sheet XML before `wb.xlsx.load`, or use a streaming reader.
3. **High — stale preview overwrites newer prices:** "Update prices" commits with no product version; `reviewSignature` ignores the matched product's prices/version. Record the matched version at analysis, include it in the signature and pass it to `applyProductUpdate`.
4. **Medium — resource limits:** inspect ignores the 2,000-row / 30-column limits (up to 5,000 × 200 cells per sheet, 20 sheets); duplicate-block detection and `brandCandidates` (`analyse.ts`) are quadratic and run on every batch read. Cap inspect, bound the algorithms, consider a worker / CPU budget.
5. **Medium — retention and access:** raw workbook cells are kept forever (also for discarded batches) and every permitted manager can read every batch. Decide a retention period (purge raw cells after commit/discard), restrict batch reads to the uploader and the owner, and log batch reads in the access trail.
6. **Concurrency:** take `product_search_lock()` at the start of the commit transaction (a commit writes many products; without it a brand rename can deadlock with it).
7. **Permissions:** decide whether import needs the *change* permission (it sets purchase prices) — it should.
8. **Low:** formula errors / uncached formulas silently become "empty"; one-cell rows are silently taken as section titles; numeric barcodes lose leading zeros; "pack" with no quantity column becomes 1; rich-text hyperlinks render as "[object Object]"; an unknown brand id in an override silently becomes "no brand"; duplicate SKUs within one file and SP above an existing MRP on update rows surface only at commit.
9. Then: re-enable by mounting `createProductImportsRouter` again (and re-adding the two upload paths to `requestGuards.ts`), restore the web routes and button, un-skip the workflow suite, extend the tests above, and have it re-audited.

The shop's "Copy" sheet (`daily expense.xlsx`, kept outside the repository) has not been imported. Its documented shape is reproduced synthetically by the retained tests.

## Keyboard shortcuts

Registered once in the app shell (`ShortcutsProvider`). Active only when `(hover: hover) and (pointer: fine) and (min-width: 1024px)` matches; phones, tablets and touch PWAs get no listener effect and no hints.

| Key | Action | Notes |
|---|---|---|
| F2 | Add expense | Ignored while typing in a field. Asks "Leave this screen?" when something typed is unsaved; does nothing on Add expense itself. |
| F4 | Product quick lookup | Works even while a normal input has focus. Opens a dialog over the current screen (nothing navigates; a half-filled form stays mounted). Typing in it is not counted as unsaved work. Esc (one press) closes it and restores focus, the caret and the selection. |
| Esc | Close the dialog | Native `<dialog>` cancel; inside the lookup's search box Esc closes rather than clearing. |

Ignored: auto-repeat, Ctrl/Alt/Meta/Shift, IME composition, while another dialog is open. F1, F5, F11, F12 (and F3, F6, F7, F8) are never handled. Hints: `F2` on the sidebar's Add expense, `F4` on the sidebar's Product lookup button, and a **Keyboard shortcuts** help panel (sidebar). Phones get a search button in the top bar for the same lookup.

## Tests

| Command (from the folder shown) | What |
|---|---|
| `server/`: `npx vitest run tests/products.critical.integration.test.ts` | CRUD, validation, SP > MRP, versions, idempotency, deactivation, codes, search (examples, typos, ranking, supplier-only last, API/database normalisation parity), search refresh, suppliers, preferred/effective price, history vs cost history, sync |
| `server/`: `npx vitest run tests/products.security.integration.test.ts` | Sentinel purchase price 987.65 / 876.54 through every route, 403s, grant/revoke, access trail |
| `server/`: `npx vitest run tests/products.remediation.integration.test.ts` | Audit remediation: view/change permissions and indirect changes through supplier links (blocked, view-only, view+change, owner), permission management, unlink versions and two concurrent changes (one wins, one 409), archived supplier cannot become preferred, access trail of every read (no amounts, none for refused reads), idempotency key reused with another price, case-insensitive barcodes, search documents under concurrent brand/category renames and product edits (both orders, no deadlock, moved product not missed) |
| `server/`: `npx vitest run tests/products.supplierArchive.integration.test.ts` | A preferred supplier cannot be archived or reactivated (owner and every manager; inactive products too; the refusal names products, never a price), explicit resolution under the change permission, ordinary suppliers unaffected, and concurrency in both orders (held transactions) plus real racing requests: never an archived preferred supplier |
| `server/`: `npx vitest run tests/productImports.postponed.integration.test.ts` | Every import route answers 503; nothing stored |
| `server/`: `npx vitest run tests/products.migration.integration.test.ts` | 0015–0017 on an existing 0014 database (data unchanged, new flags FALSE) |
| `server/`: `PRODUCT_SEARCH_BENCH=1 npx vitest run tests/products.search.bench.integration.test.ts` | Opt-in benchmark (10,000 synthetic products, test database only) |
| `web/`: `npx vitest run src/features/products src/features/shortcuts` | Catalogue reveal/hide/cache, permissions, debounce/cancellation, form rules, edit-form hide/keep/discard and background, view-only manager, 403 hides + refreshes the user, sign-out clears mutations and prices, cost history only under the protected root, unlink sends the version, no purchase price kept in the mutation cache (default price, supplier prices, product create, failed save, edit form keep-and-save), shortcut rules and behaviour |
| `web/`: `npx vitest run src/features/auth` | Account changes underneath a tab: another account on refresh forgets data and mutations, same-account refresh keeps them, session ended elsewhere, price permission revoked, two tabs (sign-in elsewhere, sign-out elsewhere without a refresh loop) |
| `web/`: `PW_CHANNEL=msedge npm run test:e2e:products` | Real browser + production build + **real API on a local test database** (seeded fresh): create/edit/search/deactivate, suppliers + preferred + reveal, unauthorised manager, import not offered (503), F4 during an expense, F2, phone layout |

Run web tests from `D:/` (upper-case drive letter) on this PC.

### Running the truncating suites on a separate disposable database

The server integration suites and the product Playwright seed **truncate** their database. By default they may use only the local `shop_books_test`. To run them without touching it, point them at a separate local database whose name looks like `shop_books_<purpose>_test` (names containing `staging` or `prod` are refused — note that "product" contains "prod"):

```
SHOP_BOOKS_TEST_DATABASE=shop_books_catalogue_fix_test \
DATABASE_URL=postgresql://<user>@localhost:<port>/shop_books_catalogue_fix_test \
npx vitest run            # in server/   (same two variables for npm run test:e2e:products in web/)
```

Every existing guard still applies to the override (local host only, exact name in the URL, the name and loopback address the server itself reports). The variables come from the shell for that one command; `.env.test` is not changed. The remediation was tested this way on a throwaway PostgreSQL 18 cluster (own data directory, port 55439, built-in `C.UTF-8` locale) because the local role cannot create databases.

## Migrations

- `0015_products` (products, costs, suppliers, search, import staging, flags, audit/auth/idempotency CHECK lists) and `0016_product_search_words` (typo-tolerance vocabulary).
- `0017_product_catalogue_hardening`: `users.can_edit_purchase_prices` (FALSE for everyone) + CHECK *edit ⇒ view*; barcode uniqueness and lookup on `lower(barcode)` (stops with a clear message, changing nothing, if two active products already differ only in barcode case); `lower(sku)` lookup index; `product_search_lock()` and the concurrency-safe `refresh_product_search` / rename trigger functions.

All three are **additive**: no existing row changes, the CHECK lists only grow, the new flags default to FALSE, and the previously deployed application keeps working against them. **Forward-only:** once product audit rows exist, the narrower CHECK lists cannot be restored (the audit log is append-only), so fixes after release are new migrations; the safety net for production is a Neon branch / snapshot taken right before migrating. 0015 replaces CHECK constraints on `financial_audit_events`, `auth_events` and `idempotency_keys`, which validates every existing row under an exclusive lock (writes to those tables wait for the duration; no row is rewritten) — migrate in a quiet period.

Applied so far only to local test databases (by the tests). `shop_books_test` is at 0016; `shop_books_dev` is at 0010 (0011–0017 pending); apply when wanted with `NODE_ENV=development npm run db:status` then `npm run db:migrate` (from `server/`, after a backup).

## Production rollout

Nothing below has been done; each step is for the owner (or with the owner's approval). **Blockers:** an independent re-audit of this remediation, and steps 1–2.

1. **Neon checks** (Neon console SQL editor, production branch, as the role in `DATABASE_URL`):
1. **Neon checks** (Neon console SQL editor, production branch, as the role in `DATABASE_URL`). All are read-only and work on PostgreSQL 14–18:
   ```sql
   -- a) Version: must be 140000 or higher (tested on 18).
   SHOW server_version_num;
   -- b) Encoding: must be UTF8. (Locale columns differ between versions, so only common ones are read.)
   SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype
     FROM pg_database WHERE datname = current_database();
   -- c) Unicode search behaviour, independent of the version and locale provider: all three must be true.
   --    (Search normalisation uses lower() and [[:alnum:]]; a plain C/POSIX ctype makes them false.)
   SELECT lower('ÉCOLE') = 'école'           AS unicode_lower,
          'é' ~ '^[[:alnum:]]$'               AS unicode_alnum,
          'नोटबुक' ~ '^[[:alnum:]]+$'          AS indic_alnum;
   -- d) pg_trgm available (must return a row) and, if already installed, its schema (must be public).
   SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'pg_trgm';
   SELECT n.nspname AS trgm_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
   -- e) Search path: must include public (migrations create pg_trgm in public and use its operators unqualified).
   SHOW search_path;
   SELECT current_schemas(false);
   -- f) Privileges: both must be true (CREATE EXTENSION of the trusted pg_trgm; new tables, indexes, functions).
   SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
          has_schema_privilege(current_user, 'public', 'CREATE')             AS schema_create;
   -- g) Existing tables that 0015-0017 ALTER (columns, CHECK constraints) or put triggers on: the role must
   --    own each one or be a member of its owner (can_alter must be true on every row, 8 rows expected).
   SELECT c.relname AS table_name,
          pg_get_userbyid(c.relowner) AS owner,
          pg_has_role(current_user, c.relowner, 'MEMBER') AS can_alter
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('users', 'expense_categories', 'financial_audit_events', 'auth_events',
                        'idempotency_keys', 'brands', 'suppliers', 'schema_migrations')
    ORDER BY 1;
   -- h) Existing functions the new triggers call: must be owned by (or executable for) the role.
   SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, has_function_privilege(current_user, p.oid, 'EXECUTE') AS can_execute
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('set_updated_at', 'prevent_financial_delete');
   -- i) Default isolation must be read committed (the search-refresh locking relies on it).
   SHOW default_transaction_isolation;
   ```
   Then, from the built API (Render shell): `npm run db:status:built` must list every migration up to `0014` as applied with matching checksums, and `0015`–`0017` as pending.
   In (g), `schema_migrations` is the migrator's history table; the other seven are altered or get triggers in 0015 (`users` also in 0017).
   If any check fails, stop: 0015 would fail and roll back completely, or search would miss non-ASCII names.
2. **Backup / branch:** create a Neon branch (or point-in-time restore point) immediately before migrating.
3. Deploy the API (Render) and the web app (Vercel) from the same commit. No new environment variables are needed (`SESSION_SECRET` already exists; do not rotate it during the rollout).
4. Migrate (Render shell, as documented in [hosted-deployment.md](hosted-deployment.md)) in a quiet period: `npm run db:status:built`, then `npm run db:migrate:built -- --confirm-database=<exact name>`; expect `0015_products`, `0016_product_search_words`, `0017_product_catalogue_hardening` (and any earlier pending ones).
5. Categories page: switch on **Use for products** for the categories you sell.
6. Users page: switch on **Can view purchase prices** for the managers who should see costs, and **Can change purchase prices** only for those who should also change them.
7. Manual checks: add a product (SP > MRP confirmation), search ("classmate register", "a4 140", a typo, a barcode in other letter case), link two suppliers and change the preferred one, reveal/hide purchase prices (list, detail, edit form, history), edit a purchase price and hide it before saving (keep / discard), a view-only manager cannot change prices or remove a priced supplier, a manager without permission sees no prices, F2/F4 on a desktop, the phone layout, and that `/products/import` offers nothing.
