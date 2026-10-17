'use strict';
const { SOURCE_REFS, hashJson, hashText, validateInput, safeSelectedText } = require('./text-draft.cjs');
const SOURCE_URLS = Object.freeze({
  inventory: 'https://docs.google.com/spreadsheets/d/1JhlaNnwKEQY1OUQnsCMrCDPk3ADooXMdaCm8Hzb87uM/gviz/tq?tqx=out:csv',
});
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function parseCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text,'utf8') > MAX_SOURCE_BYTES) fail('draft_inventory_unavailable');
  const rows=[]; let row=[], field='', quoted=false, closed=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) { if(c==='"') { if(text[i+1]==='"') {field+='"';i++;} else {quoted=false;closed=true;} } else field+=c; }
    else if(c==='"') { if(field!=='' || closed) fail('draft_csv_invalid'); quoted=true; }
    else if(c===',') {row.push(field);field='';closed=false;}
    else if(c==='\r'||c==='\n') { if(c==='\r'&&text[i+1]==='\n')i++;row.push(field); if(row.some(v=>v!==''))rows.push(row);row=[];field='';closed=false; }
    else { if(closed)fail('draft_csv_invalid');field+=c; }
  }
  if(quoted)fail('draft_csv_invalid');
  row.push(field);if(row.some(v=>v!==''))rows.push(row);
  if(rows.length<2 || rows.length>10000)fail('draft_csv_invalid');
  rows[0][0]=rows[0][0].replace(/^\uFEFF/,'');
  if(rows.some(r=>r.length!==rows[0].length))fail('draft_csv_invalid');
  return rows;
}
function parseInventory(text, plotNumber) {
  const rows=parseCsv(text),head=rows[0].map(s=>s.trim().toLowerCase());
  const aliases={plot_number:['номер','номер участка','№','№ участка','участок'],status_raw:['статус','состояние'],area_raw:['площадь','площадь, сот','площадь (сот)','соток'],price_raw:['цена','стоимость','цена, руб','цена (руб)']};
  const indices={};
  for(const [name,names] of Object.entries(aliases)){ const matches=head.map((v,i)=>names.includes(v)?i:-1).filter(i=>i>=0);if(matches.length!==1)fail('draft_inventory_columns_unknown');indices[name]=matches[0]; }
  const selected=rows.slice(1).filter(r=>r[indices.plot_number]===plotNumber);
  if(selected.length!==1)fail('draft_inventory_plot_ambiguous');
  const out={project_id:'sb',...Object.fromEntries(Object.entries(indices).map(([k,i])=>[k,selected[0][i]])),currency:'RUB'};
  if(!['Свободен','Акция'].includes(out.status_raw))fail('draft_inventory_not_available');
  return out;
}
async function fetchFixedSource(type,{fetchImpl=globalThis.fetch}={}){
  const url=SOURCE_URLS[type];if(!url)fail('draft_source_configuration_missing');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);timer.unref?.();
  try {
    const response=await fetchImpl(url,{method:'GET',headers:{Accept:type==='inventory'?'text/csv':'text/plain'},redirect:'error',credentials:'omit',signal:controller.signal});
    if(!response.ok||response.redirected||!response.body?.getReader)fail('draft_source_unavailable');
    const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_SOURCE_BYTES))fail('draft_source_too_large');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_SOURCE_BYTES){await reader.cancel();fail('draft_source_too_large');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
    const text=Buffer.concat(chunks,size).toString('utf8');
    const modified=response.headers.get('last-modified');return{text,modifiedAt:modified&&Number.isFinite(Date.parse(modified))?new Date(modified).toISOString():null};
  } catch(error){if(error?.code)throw error;fail('draft_source_unavailable');}finally{clearTimeout(timer);}
}
function snapshot(type,raw,data,observedAt){return{source_ref:SOURCE_REFS[type],revision:hashText(raw.text),observed_at:observedAt,source_modified_at:raw.modifiedAt??null,sha256:hashJson(data),data};}
async function materializeTextDraftInput(seed,{observedAt,fetchImpl=globalThis.fetch,readSource}={}){
  validateInput(seed,{production:true,now:observedAt});
  if(!seed.snapshots.project||!seed.snapshots.cadastre||seed.snapshots.source_text!==null||seed.snapshots.calendar!==null)fail('draft_source_missing');
  // Selected immutable KB evidence arrives through the existing director-authenticated
  // task. No private repository credential or raw private source fetch is introduced.
  const inventoryRaw=await (readSource?readSource('inventory'):fetchFixedSource('inventory',{fetchImpl}));
  if(!inventoryRaw||typeof inventoryRaw.text!=='string'||Buffer.byteLength(inventoryRaw.text,'utf8')>MAX_SOURCE_BYTES)fail('draft_source_unavailable');
  const inventory=parseInventory(inventoryRaw.text,seed.selection.plot_number);
  const input={...JSON.parse(JSON.stringify(seed)),evaluated_at:observedAt};
  input.snapshots.inventory=snapshot('inventory',inventoryRaw,inventory,observedAt);
  if(seed.snapshots.inventory&&seed.snapshots.inventory.revision!==input.snapshots.inventory.revision)fail('draft_source_changed');
  return validateInput(input,{complete:true,production:true,now:observedAt});
}
module.exports={SOURCE_URLS,MAX_SOURCE_BYTES,parseCsv,parseInventory,fetchFixedSource,materializeTextDraftInput,snapshot};
