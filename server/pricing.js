// Match orderr.prix's NUMERIC(10,2), so receipts, points and line sums agree.
export const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export async function loadPrices(db, items) {
  const names = [...new Set(items.map(item => String(item.idname)))];
  const result = await db.query('SELECT idname, price FROM product WHERE idname = ANY($1) AND archived = FALSE', [names]);
  const prices = new Map(result.rows.map(row => [String(row.idname), Number(row.price)]));
  if (names.some(name => !prices.has(name) || !Number.isFinite(prices.get(name)) || prices.get(name) < 0)) {
    const error = new Error('INVALID_PRODUCT');
    error.status = 400;
    throw error;
  }
  return prices;
}

export function linePrice(item, prices, percent = 0, freeIds = new Set(), index = -1) {
  return freeIds.has(index) ? 0 : money(prices.get(String(item.idname)) * (100 - percent) / 100);
}

export function baseTotal(items, prices, percent = 0, freeIds = new Set()) {
  return money(items.reduce((sum, item, index) => sum + linePrice(item, prices, percent, freeIds, index), 0));
}

export async function promotionPercent(db, total) {
  const result = await db.query(`
    SELECT discount_percent, minimum_purchase_amount FROM promotion
    WHERE start_date <= $1 AND end_date >= $1
    ORDER BY discount_percent DESC LIMIT 1
  `, [new Date().toISOString()]);
  const promo = result.rows[0];
  const percent = Number(promo?.discount_percent || 0);
  return promo && total >= Number(promo.minimum_purchase_amount || 0)
    && percent > 0 && percent <= 100 ? percent : 0;
}
