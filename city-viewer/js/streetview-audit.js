// The only public audit document is a pair of aggregate populations. Unknown fields
// are rejected rather than serialized: in particular, no input filenames, IDs or observations.
const sourceKeys = ['regular','hidden','time-machine','unknown','missing','other'];
const categories = ['regular','hidden','time-machine','unknown'];
const statuses = ['regular-confirmed','user-confirmed-hidden','time-machine-roundtrip','time-machine-one-way','time-machine-history-only','hidden-candidate','access-error','unknown'];
const bases = ['binzhou-user-confirmed-source','tumushuke-user-confirmed-source','binzhou-official-browser','source-parent-history-reference','insufficient-evidence'];
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
  if(doc.schemaVersion!==2||doc.scope!=='canonical-and-input-rows-separate')throw Error('Invalid public audit schema');
  for(const group of ['catalog','uploads']){
    const s=doc[group],extra=group==='catalog'?['collections']:diagnostics;
    allow(s,['rows','files','bySource','byCategory','byStatus','byBasis','sourceByStatus',...extra],group);
    if(![s.rows,s.files,...extra.map(k=>s[k])].every(integer))throw Error('Invalid public audit denominator');
    distribution(s.bySource,sourceKeys,s.rows);distribution(s.byCategory,categories,s.rows);distribution(s.byStatus,statuses,s.rows);distribution(s.byBasis,bases,s.rows);
    allow(s.sourceByStatus,sourceKeys,'cross-tab');const column={};
    for(const k of sourceKeys){const entry=s.sourceByStatus[k]??{};distribution(entry,statuses,s.bySource[k]??0);for(const [status,n] of Object.entries(entry))column[status]=(column[status]??0)+n;}
    if(statuses.some(k=>(column[k]??0)!==(s.byStatus[k]??0)))throw Error('Public audit cross-tab mismatch');
    if(group==='uploads'&&(diagnostics.slice(0,4).reduce((n,k)=>n+s[k],0)!==s.rows||diagnostics.slice(4,8).reduce((n,k)=>n+s[k],0)!==s.rows||s.metadataOnly>s.rows))throw Error('Upload diagnostics mismatch');
  }
  if(doc.catalog.rows!==archiveTotal)throw Error('Public audit differs from archived row count');
  return doc;
}
