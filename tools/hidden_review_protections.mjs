// These predicates recognize declarations on canonical, trusted catalog rows, NOT uploaded claims.
// Before applying or publishing any result, finish every receipt for the city with verifyProtectionCity.
import { createHash } from 'node:crypto';
import policy from '../config/reviews/hidden-policy-protected.json' with { type: 'json' };
import { isOverlapReview, overlapReview } from './supp23_manual_review.mjs';

const { manualTimeMachine: tm, binzhou, alxa, xinxiang, tumushuke, official, overlap } = policy;
if (overlap.idSetSha256 !== overlapReview.idSetSha256 || overlap.total !== overlapReview.total ||
    tumushuke.sourceZipSha256 !== overlapReview.sourceZipSha256) throw Error('Inconsistent protection receipts');
const receipts = Object.create(null);
function addReceipt(city, basis, {count, idsSha256}) {
  (receipts[city] ??= Object.create(null))[basis] = Object.freeze({count, idsSha256});
}
for (const [city, scope] of Object.entries(tm.cities)) addReceipt(city, tm.basis, scope);
for (const scope of [binzhou, alxa, xinxiang, tumushuke]) addReceipt(scope.city, scope.basis, scope);
for (const [city, scope] of Object.entries(overlapReview.cities)) addReceipt(city, overlap.basis, scope);
for (const scope of Object.values(receipts)) Object.freeze(scope);
export const protectionCityReceipts = Object.freeze(receipts);

const decision = (category, status, basis) => Object.freeze({category, status, basis});
const directedTime = decision('time-machine', 'time-machine-manual-confirmed', tm.basis);
const binzhouHidden = decision('hidden', 'user-confirmed-hidden', binzhou.basis);
const alxaHidden = decision('hidden', 'user-confirmed-hidden', alxa.basis);
const xinxiangHidden = decision('hidden', 'user-confirmed-hidden', xinxiang.basis);
const tumushukeRegular = decision('regular', 'regular-confirmed', tumushuke.basis);
const overlapRegular = decision('regular', 'regular-confirmed', overlap.basis);
const officialMap = new Map(Object.entries(official.decisions).map(([id, {category, status}]) => [id, decision(category, status, official.basis)]));
const isId = id => typeof id === 'string' && /^[A-Za-z0-9]{27}$/.test(id);
const isPrimary = row => Array.isArray(row) && row[8] === 'baidu' && isId(row[0]) && !row[9]?.blueDot;
export function officialProtection(id) { return officialMap.get(id) ?? null; }

export function declaredProtection(row, city) {
  if (!receipts[city] || !isPrimary(row)) return null;
  const m = row[9], x = m?.extra;
  if (city === xinxiang.city && row[0] === xinxiang.panoid && m?.sourceType === 'hidden' && m.isHidden === true) return xinxiangHidden;
  if (!x) return null;
  if (city === alxa.city) {
    return m.sourceType === 'hidden' && m.isHidden === true && x.sourceFile === alxa.sourceFile && x.sourceSha256 === alxa.sourceSha256 ? alxaHidden : null;
  }
  const region = Object.hasOwn(tm.cities, city) && tm.cities[city];
  if (region) {
    const review = x.manualReview;
    return m.sourceType === 'time-machine' && m.isHidden === false && x.previousSourceType === tm.previousSourceType &&
      x.crawlerSource === region.sourceFile && x.vehicleId === region.vehicleId && review?.date === tm.reviewDate &&
      review.reason === tm.reviewReason && review.scope === region.scope ? directedTime : null;
  }
  if (city === tumushuke.city) {
    return m.sourceType === 'regular' && !Object.hasOwn(m, 'isHidden') && x.sourceBatch === tumushuke.sourceBatch &&
      x.sourceZipSha256 === tumushuke.sourceZipSha256 && x.classificationBasis === 'user-confirmed-regular' &&
      x.classificationReviewedAt === tumushuke.reviewDate && tumushuke.reviewReasons.includes(x.classificationReason) &&
      !Object.hasOwn(x, 'manualReview') ? tumushukeRegular : null;
  }
  return isOverlapReview(row, city) ? overlapRegular : null;
}

// binzhouHiddenIds must be derived from the fixed first source, never a city's current hidden labels.
// An already reviewed ID takes precedence over raw isHidden, mobility and history metadata.
export function protectedDecision(row, city, binzhouHiddenIds) {
  if (!isPrimary(row)) return null;
  if (city === binzhou.city && binzhouHiddenIds?.has(row[0])) return binzhouHidden;
  return declaredProtection(row, city) ?? (city === official.city ? officialProtection(row[0]) : null);
}

// No hash of a count or a subset is a membership test. Reject duplicates, equal-size swaps,
// malformed IDs, unknown basis, and missing groups. Caller must also check for missing cities.
export function verifyProtectionCity(city, byBasis = {}) {
  const expected = receipts[city];
  for (const basis of Object.keys(byBasis)) if (!expected?.[basis]) throw Error(`Unexpected protection group: ${city}/${basis}`);
  for (const [basis, receipt] of Object.entries(expected ?? {})) {
    const ids = byBasis[basis];
    if (!Array.isArray(ids) || ids.length !== receipt.count) throw Error(`Protection count mismatch: ${city}/${basis}`);
    const sorted = ids.slice().sort(), hash = createHash('sha256');
    for (const [i, id] of sorted.entries()) {
      if (!isId(id) || (i && sorted[i - 1] === id)) throw Error(`Invalid or duplicate protection ID: ${city}/${basis}`);
      hash.update(id + '\n', 'ascii');
    }
    if (hash.digest('hex') !== receipt.idsSha256) throw Error(`Protection ID fingerprint mismatch: ${city}/${basis}`);
  }
  return true;
}
