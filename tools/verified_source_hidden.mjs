import { createHash } from 'node:crypto';
import receipt from '../config/reviews/source-hidden-flags.json' with { type: 'json' };

for(const c of Object.values(receipt.cities))Object.freeze(c);
Object.freeze(receipt.cities);
export const verifiedSourceHidden=Object.freeze(receipt);
export function verifyHiddenCitySet(city,ids,expected=receipt){
  if(expected.state!=='verified'||expected.policy!=='source-isHidden-boolean-v1'||!/^\d{6}$/.test(city)||!Array.isArray(ids))throw Error('Unverified source hidden receipt or city');
  const spec=expected.cities[city];
  if(ids.length!==(spec?.count??0))throw Error('Source hidden ID count mismatch: '+city);
  if(!spec)return true;
  const h=createHash('sha256');let last='';
  for(const id of ids.slice().sort()){if(typeof id!=='string'||!(/^[!-~]+$/).test(id)||id===last)throw Error('Invalid/duplicate hidden ID: '+city);h.update(id+'\n','ascii');last=id;}
  if(h.digest('hex')!==spec.idsSha256)throw Error('Source hidden ID fingerprint mismatch: '+city);
  return true;
}
