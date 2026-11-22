import type { RequestHandler, Response } from 'express';
import { getAuth } from '../../middleware/auth.js';
import { AppError } from '../../utils/errors.js';

/**
 * Purchase prices are commercially sensitive. Two separate permissions (migration 0017):
 *
 *   SEE    owner always; a manager only with users.can_view_purchase_prices
 *   CHANGE owner always; a manager only with users.can_edit_purchase_prices (which requires SEE)
 *
 * CHANGE covers every write that alters a stored purchase price or the effective purchase price:
 * the default price, supplier prices, unlinking a supplier whose link holds a price, and moving
 * the preferred flag to or from a link that holds a price (productCosts.service.ts enforces the
 * supplier-link rules inside the transaction, so no route can bypass them).
 *
 * Both values are read from the database on EVERY request (findActiveSession), so granting or
 * revoking takes effect on the next request without touching sessions. Hiding prices in the
 * browser is a convenience only: these server checks are the control.
 */
export function canViewPurchasePrices(res: Response): boolean {
  return getAuth(res).user.canViewPurchasePrices === true;
}

export function canEditPurchasePrices(res: Response): boolean {
  const user = getAuth(res).user;
  return user.canViewPurchasePrices === true && user.canEditPurchasePrices === true;
}

export const PURCHASE_PRICE_FORBIDDEN = () =>
  new AppError(403, 'PURCHASE_PRICE_FORBIDDEN', 'You do not have permission to see purchase prices');

export const PURCHASE_PRICE_CHANGE_FORBIDDEN = (message = 'You do not have permission to change purchase prices') =>
  new AppError(403, 'PURCHASE_PRICE_CHANGE_FORBIDDEN', message);

/** Gate for routes that READ purchase prices. */
export const requirePurchasePriceAccess: RequestHandler = (_req, res, next) => {
  if (!canViewPurchasePrices(res)) return next(PURCHASE_PRICE_FORBIDDEN());
  next();
};

/** Gate for routes whose only purpose is to CHANGE purchase prices. */
export const requirePurchasePriceChange: RequestHandler = (_req, res, next) => {
  if (!canViewPurchasePrices(res)) return next(PURCHASE_PRICE_FORBIDDEN());
  if (!canEditPurchasePrices(res)) return next(PURCHASE_PRICE_CHANGE_FORBIDDEN());
  next();
};
