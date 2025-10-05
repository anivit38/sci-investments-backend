// backend/services/domination.js
// Compute "Buyer" | "Seller" per day using intraday prints.
// Preferred: provide ticks {t, price, size, bid?, ask?}. We classify:
// - If bid/ask present: price >= ask => Buyer; price <= bid => Seller.
// - Else uptick rule: price > prevPrice => Buyer; price < prevPrice => Seller.
// Return majority label per day. If no intraday, fall back to null.

function classifyDayDomination(ticks) {
  if (!Array.isArray(ticks) || ticks.length < 2) return null;
  let buyers = 0, sellers = 0;
  let prev = ticks[0].price;
  for (const tk of ticks) {
    const { price, bid, ask } = tk;
    if (Number.isFinite(bid) && Number.isFinite(ask)) {
      if (price >= ask) buyers++;
      else if (price <= bid) sellers++;
      else {
        // mid-print: tick test
        if (price > prev) buyers++;
        else if (price < prev) sellers++;
      }
    } else {
      if (price > prev) buyers++;
      else if (price < prev) sellers++;
    }
    prev = price;
  }
  if (buyers === sellers) return 'Neutral';
  return buyers > sellers ? 'Buyer' : 'Seller';
}

// Build per-day domination array from ticksByDay: [{date:'YYYY-MM-DD', ticks:[...]}]
function buildDominationSeries(candles, ticksByDayMap /* Map(date)->ticks[] */) {
  const out = [];
  for (const c of candles) {
    const d = c.t?.slice(0,10) || c.t;
    const ticks = ticksByDayMap?.get?.(d) || null;
    out.push(classifyDayDomination(ticks));
  }
  return out;
}

module.exports = { classifyDayDomination, buildDominationSeries };
