// A user decision about an exact list of primary IDs, not an inference from topology or dates.
import { createHash } from 'node:crypto';
import receipt from '../config/reviews/supp23-hidden-overlap.json' with { type: 'json' };

const cityRoster = Object.entries(receipt.cities).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
const rosterHash = createHash('sha256');
for (const [code, item] of cityRoster) rosterHash.update(`${code}\t${item.count}\t${item.idsSha256}\n`, 'ascii');
if (receipt.idSetSha256 !== 'e58401a855f770dc7acb9d9dbf90c4a1ec23faa7630c2b1de4e833d8cf0941f1' ||
    rosterHash.digest('hex') !== 'c9ee688b62cf4bc6907f1dda29cac018ade8e1b48be6bc71a4be78af066e59ff') throw Error('Manual review receipt differs from approved ID set');
for (const city of Object.values(receipt.cities)) Object.freeze(city);
Object.freeze(receipt.cities);
export const overlapReview = Object.freeze(receipt);
const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// This checks a record's declaration. Consumers accepting a whole-city correction must also
// call verifyOverlapCity: a matching row count or the presence of a human-readable tag is not an allowlist.
export function isOverlapReview(row, city) {
  const m = row?.[9], x = m?.extra, manual = x?.manualReview;
  return owns(receipt.cities, city) && row?.[8] === 'baidu' && m?.sourceType === receipt.to && !owns(m, 'isHidden') &&
    Array.isArray(m.tags) && m.tags.includes(receipt.tag) && x?.sourceBatch === receipt.sourceBatch &&
    x?.sourceZipSha256 === receipt.sourceZipSha256 && x?.classificationBasis === 'user-confirmed-regular' &&
    x.classificationReviewedAt === receipt.reviewedAt && x.classificationReason === receipt.reason &&
    x.previousSourceType === receipt.from && !x.inheritedCoordinate && manual?.scope === receipt.reviewId &&
    manual.date === receipt.reviewedAt && manual.reason === receipt.reason && manual.previousSourceType === receipt.from;
}

export function verifyOverlapCity(city, ids) {
  const target = receipt.cities[city];
  if (!target || !Array.isArray(ids) || ids.length !== target.count) throw Error(`Manual review count mismatch: ${city}`);
  const ordered = ids.slice().sort(); // bounded by the largest single city's 32,156 IDs
  const hash = createHash('sha256');
  for (const [i, id] of ordered.entries()) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9]{27}$/.test(id) || (i && ordered[i-1] === id)) throw Error(`Invalid or duplicate manual review ID: ${city}`);
    hash.update(id+'\n','ascii');
  }
  if (hash.digest('hex') !== target.idsSha256) throw Error(`Manual review ID fingerprint mismatch: ${city}`);
  return true;
}

// Call only for an ID from the signed-off list after verifying its location and previous state.
export function markOverlapRegular(row, city) {
  const m = row?.[9], x = m?.extra;
  if (!owns(receipt.cities, city) || row?.[8] !== 'baidu' || m?.sourceType !== receipt.from || m.isHidden !== true ||
      x?.sourceBatch !== receipt.sourceBatch || x?.sourceZipSha256 !== receipt.sourceZipSha256 ||
      x.inheritedCoordinate || !Array.isArray(m.tags) || m.tags.includes(receipt.tag) ||
      ['manualReview','previousSourceType','classificationBasis','classificationReason','classificationReviewedAt'].some(k => owns(x,k))) {
    throw Error(`Refusing to overwrite an unexpected classification: ${city}/${row?.[0]}`);
  }
  const {isHidden, ...rest} = m;
  return [...row.slice(0,9), {...rest,sourceType:receipt.to,tags:[...m.tags,receipt.tag],extra:{...x,
    previousSourceType:receipt.from,classificationBasis:'user-confirmed-regular',classificationReviewedAt:receipt.reviewedAt,
    classificationReason:receipt.reason,manualReview:{scope:receipt.reviewId,date:receipt.reviewedAt,reason:receipt.reason,previousSourceType:receipt.from},
  }}];
}
