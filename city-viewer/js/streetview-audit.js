// The only public audit document is a pair of aggregate populations. Unknown fields
// are rejected rather than serialized: in particular, no input filenames, IDs or observations.
const sourceKeys = ['regular','hidden','time-machine','unknown','missing','other'];
const categories = ['regular','hidden','time-machine','unknown'];
const legacyStatuses = ['regular-confirmed','user-confirmed-hidden','time-machine-roundtrip','time-machine-one-way','time-machine-history-only','hidden-candidate','access-error','unknown'];
const currentStatuses = [...legacyStatuses.filter(s=>s!=='hidden-candidate'), 'source-isHidden-true','time-machine-manual-confirmed'];
const legacyBases = ['binzhou-user-confirmed-source','tumushuke-user-confirmed-source','supp23-overlap-user-confirmed','binzhou-official-browser','source-parent-history-reference','insufficient-evidence'];
const currentBases = [...legacyBases,'source-isHidden-true','user-directed-time-machine','alxa-user-directed-hidden-batch','xinxiang-user-directed-hidden'];
const diagnostics = ['timelineEmpty','timelineSingle','timelineMultiple','timelineMissing','movementZero','movementPositive','movementMissing','movementInvalid','metadataOnly'];
const integer = v => Number.isSafeInteger(v) && v >= 0;
function allow(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) throw Error('Unexpected public audit fields: '+label);
}
function distribution(obj, keys, rows) {
  allow(obj,keys,'distribution');const values=Object.values(obj);
  if (!values.every(integer)||values.reduce((a,b)=>a+b,0)!==rows)throw Error('Public audit counts do not reconcile');
}
export function validatePublicAudit(doc,archiveTotal) {
  allow(doc,['schemaVersion','scope','catalog','uploads'],'root');
  if(![2,3].includes(doc.schemaVersion)||doc.scope!=='canonical-and-input-rows-separate')throw Error('Invalid public audit schema');
  const current=doc.schemaVersion===3, statuses=current?currentStatuses:legacyStatuses, bases=current?currentBases:legacyBases;
  for(const group of ['catalog','uploads']){
    const s=doc[group],extra=group==='catalog'?['collections']:diagnostics;
    allow(s,['rows','files','bySource','byCategory','byStatus','byBasis','sourceByStatus',...extra],group);
    if(![s.rows,s.files,...extra.map(k=>s[k])].every(integer))throw Error('Invalid public audit denominator');
    distribution(s.bySource,sourceKeys,s.rows);distribution(s.byCategory,categories,s.rows);distribution(s.byStatus,statuses,s.rows);distribution(s.byBasis,bases,s.rows);
    if(current){
      const status=k=>s.byStatus[k]??0, basis=k=>s.byBasis[k]??0, category=k=>s.byCategory[k]??0;
      if(status('source-isHidden-true')!==basis('source-isHidden-true') ||
         status('user-confirmed-hidden')!==basis('alxa-user-directed-hidden-batch')+basis('xinxiang-user-directed-hidden')+basis('binzhou-user-confirmed-source') ||
         category('hidden')!==status('source-isHidden-true')+status('user-confirmed-hidden') ||
         status('time-machine-manual-confirmed')!==basis('user-directed-time-machine') ||
         category('time-machine')!==['time-machine-manual-confirmed','time-machine-roundtrip','time-machine-one-way','time-machine-history-only'].reduce((n,k)=>n+status(k),0) ||
         category('regular')!==status('regular-confirmed') || category('unknown')!==status('unknown')+status('access-error')) throw Error('Public audit classification evidence mismatch');
    }
    allow(s.sourceByStatus,sourceKeys,'cross-tab');const column={};
    for(const k of sourceKeys){const entry=s.sourceByStatus[k]??{};distribution(entry,statuses,s.bySource[k]??0);for(const [status,n] of Object.entries(entry))column[status]=(column[status]??0)+n;}
    if(statuses.some(k=>(column[k]??0)!==(s.byStatus[k]??0)))throw Error('Public audit cross-tab mismatch');
    if(group==='uploads'&&(diagnostics.slice(0,4).reduce((n,k)=>n+s[k],0)!==s.rows||diagnostics.slice(4,8).reduce((n,k)=>n+s[k],0)!==s.rows||s.metadataOnly>s.rows))throw Error('Upload diagnostics mismatch');
  }
  if(doc.catalog.rows!==archiveTotal)throw Error('Public audit differs from archived row count');
  return doc;
}
