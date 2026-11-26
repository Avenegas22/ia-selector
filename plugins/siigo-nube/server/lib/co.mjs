// Colombian accounting helpers that don't need the API.

/**
 * DIAN check digit (dígito de verificación) for a NIT.
 * Algorithm: weights 3,7,13,17,19,23,29,37,41,43,47,53,59,67,71 applied right
 * to left, sum mod 11; result r → (r > 1 ? 11 - r : r).
 * @param {string|number} nit digits only, without DV
 */
export function nitCheckDigit(nit) {
  const digits = String(nit).replace(/\D/g, "");
  if (!digits) throw new Error("NIT vacío");
  if (digits.length > 15) throw new Error("NIT demasiado largo (máx. 15 dígitos)");
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[digits.length - 1 - i]) * weights[i];
  }
  const r = sum % 11;
  return r > 1 ? 11 - r : r;
}

/** Calendar-day difference b - a for YYYY-MM-DD strings. */
export function daysBetween(a, b) {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((db - da) / 86400000);
}

export function todayBogota() {
  // Colombia is UTC-5 year-round (no DST).
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

export const AGING_BUCKETS = [
  { key: "corriente", label: "Por vencer", min: -Infinity, max: 0 },
  { key: "1_30", label: "1–30 días", min: 1, max: 30 },
  { key: "31_60", label: "31–60 días", min: 31, max: 60 },
  { key: "61_90", label: "61–90 días", min: 61, max: 90 },
  { key: "mas_90", label: "Más de 90 días", min: 91, max: Infinity },
];

export function bucketFor(daysOverdue) {
  return AGING_BUCKETS.find((b) => daysOverdue >= b.min && daysOverdue <= b.max).key;
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
