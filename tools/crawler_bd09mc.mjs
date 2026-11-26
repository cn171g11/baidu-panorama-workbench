// Inverse Baidu Mercator for checking the x/y in crawler exports. These are BD09MC
// metres, not EPSG:3857. The source of the six latitude-band fits is cited in the table.
import coefficients from './bd09mc-coefficients.json' with { type: 'json' };

export function mcToBd09(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 20037727 || Math.abs(y) > 12474104.18) {
    throw new RangeError('Invalid BD09MC metres');
  }
  const i = coefficients.MC_BANDS.findIndex(band => Math.abs(y) >= band);
  const f = coefficients.MC_TO_LL[i], t = Math.abs(y) / f[9];
  let lat = f[2];
  for (let k = 1; k <= 6; k++) lat += f[k + 2] * t ** k;
  const lng = f[0] + f[1] * Math.abs(x);
  if (lng > 180.000001 || Math.abs(lat) > 74.0001) throw new RangeError('Outside the supported BD09MC domain');
  return [x < 0 ? -lng : lng, y < 0 ? -lat : lat];
}
