'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../work-preparation/text-draft.cjs'),S=require('../work-preparation/text-draft-sources.cjs');
// Synthetic-only fixtures. All transports are in-memory; no external requests.
const AT='2026-10-17T14:00:00.000Z', clone=x=>JSON.parse(JSON.stringify(x));
const CSV='"Участок","Статус","Площадь","Цена","Цена за сотку",""\n"4","Акция","9,99","123456","ignored",""\n';
const TOKEN='synthetic-draft-test-'+'x'.repeat(40);
function seed(agent='content'){
 const v=D.seedInput({kind:agent+'.text_draft.prepare',evaluatedAt:AT});
 const snap=(type,data)=>({source_ref:D.SOURCE_REFS[type],revision:D.hashText('synthetic-'+type),observed_at:AT,source_modified_at:null,sha256:D.hashJson(data),data});
 v.snapshots.project=snap('project',{project_id:'sb',facts:[{fact_id:'synthetic_project',text:'SYNTHETIC project fact',quote:'SYNTHETIC project fact',source_record_id:'synthetic:L1'}]});
 v.snapshots.cadastre=snap('cadastre',{project_id:'sb',plot_number:'4',cadastral_number:'99:99:999999:999',area_raw:'9,99',facts:[{fact_id:'synthetic_identity',text:'99:99:999999:999',quote:'99:99:999999:999',source_record_id:'synthetic:L2'}]});
 return v;
}
async function materialized(agent='content',csv=CSV){return S.materializeTextDraftInput(seed(agent),{observedAt:AT,readSource:async type=>{assert.equal(type,'inventory');return{text:csv,modifiedAt:null};}});}
function task(v=seed()){
 const agent=v.kind.split('.')[0],identity={plan_id:'op_'+'1'.repeat(64),work:{objective:'SYNTHETIC text-only test',priority:'normal',dependencies:[],acceptance:v.kind+'.v1'},agent,kind:v.kind,created_at:AT,deadline:'2026-10-17T15:00:00.000Z',parent_task_id:null,payload:v};
 const id='ot_'+D.hashJson(identity);return{protocol:1,task_id:id,idempotency_key:id,...identity};
}
function artifact(input,t){
 const items=Array.from({length:input.output.count},(_,i)=>({id:'synthetic_'+i,title:'SYNTHETIC internal text',body:'SYNTHETIC body. '.repeat(t.agent==='avitolog'?40:20),claims:[{text:'SYNTHETIC',source_id:'github.kb.sb.location',fact_id:'synthetic_project',quote:'SYNTHETIC project fact'},{text:'SYNTHETIC',source_id:'github.kb.sb.cadastre',fact_id:'synthetic_identity',quote:'99:99:999999:999'}]}));
 const raw={items,uncertainties:[],excluded_claims:[]},ih=D.hashJson(input);
 return{schema_version:D.ARTIFACT_VERSION,kind:t.kind,status:'generated',publication_authorized:false,input_hash:ih,...raw,financial_source_strings:['123456'],provenance:{task_id:t.task_id,request_hash:D.hashJson(t),operation_key:D.operationKey(t.task_id,ih),purpose:t.agent+'.internal_draft',request_id:'synthetic_request',thread_id:'synthetic_thread',model:'synthetic-model',input_hash:ih,output_hash:D.hashJson(raw),prompt_version:D.PROMPT_VERSION,schema_hash:D.hashJson(D.MODEL_SCHEMA)}};
}
function core(t=task()){
 const claim={task:t,request_hash:D.hashJson(t),lease_id:'l'.repeat(43),accepted_at:AT,lease_until:'2026-10-17T14:05:00.000Z'};
 const state={task:t,request_hash:claim.request_hash,input:null,input_hash:null,artifact:null,status:'accepted'},calls=[];
 const request=async(method,path,body)=>{calls.push({method,path,body:clone(body??null)});if(method==='GET')return clone(state);if(path.endsWith('/input')){state.input=clone(body.input);state.input_hash=D.hashJson(body.input);state.status='running';return{task_id:t.task_id,request_hash:claim.request_hash,input_hash:state.input_hash,status:'running'};}if(path.endsWith('/result')){state.artifact=clone(body.artifact);state.status=body.status;return{task_id:t.task_id,request_hash:claim.request_hash,input_hash:state.input_hash,status:body.status,artifact_hash:D.hashJson(body.artifact)};}throw Error('unexpected route');};
 return{claim,state,calls,request};
}
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
test('default disabled; grants distinct from operation/legacy/opposite-role tokens',()=>{
 assert.equal(D.draftConfiguration({},'content'),null);
 for(const key of ['OPERATION_TASK_TOKEN','AVITOLOG_DRAFT_BACKEND_TOKEN','AVITOLOG_BACKEND_TOKEN','CODEX_BACKEND_TOKEN'])assert.throws(()=>D.draftConfiguration({MARKETING_DRAFTS_ENABLED:'true',CONTENT_DRAFT_BACKEND_TOKEN:TOKEN,[key]:TOKEN},'content'),/configuration/);
 assert.equal(D.draftConfiguration({MARKETING_DRAFTS_ENABLED:'true',CONTENT_DRAFT_BACKEND_TOKEN:TOKEN},'content').purpose,'content.internal_draft');
});
test('source loader fresh CSV only; private evidence copied byte-for-byte, money raw unchanged',async()=>{
 const v=await materialized();assert.equal(v.snapshots.inventory.data.price_raw,'123456');assert.equal(v.snapshots.inventory.data.area_raw,'9,99');assert.ok(!Object.hasOwn(v.snapshots.inventory.data,'cadastral_number'));
 assert.deepEqual(v.snapshots.project,seed().snapshots.project);assert.deepEqual(v.snapshots.cadastre,seed().snapshots.cadastre);assert.equal(v.snapshots.inventory.revision,D.hashText(CSV));
});
test('sold/reserved/empty financial fields, duplicate plot and conflicting area fail closed',async()=>{
 for(const csv of [CSV.replace('Акция','Продан'),CSV.replace('Акция','Резерв'),CSV.replace('"123456"','""'),CSV.replace('"9,99"','"9,98"'),CSV+'"4","Свободен","9,99","123456","ignored",""\n'])await assert.rejects(materialized('content',csv));
});
test('unbounded, changed source, private data and client policy fields rejected',async()=>{
 const v=await materialized();const a=clone(v);a.model='arbitrary';assert.throws(()=>D.validateInput(a));
 const b=clone(v);b.snapshots.project.data.facts[0].text='private@example.com';b.snapshots.project.data.facts[0].quote=b.snapshots.project.data.facts[0].text;b.snapshots.project.sha256=D.hashJson(b.snapshots.project.data);assert.throws(()=>D.validateInput(b),/selected_data/);
 assert.throws(()=>D.sameIntent(v,b),/static_source_changed|selected_data/);
 const c=clone(v);c.snapshots.inventory.data.price_raw='654321';assert.throws(()=>D.validateInput(c),/binding/);
 const d=clone(v);d.snapshots.calendar={};assert.throws(()=>D.validateInput(d));
});
test('inventory 15m, static evidence24h, synthetic production input rejected',async()=>{
 const v=await materialized();assert.throws(()=>D.validateInput(v,{now:'2026-10-17T14:16:00.000Z'}),/binding|inventory/);
 const b=seed();b.snapshots.project.observed_at='2026-10-16T13:59:00.000Z';assert.throws(()=>D.validateInput(b),/binding/);
 const c=seed();c.input_class='synthetic';assert.throws(()=>D.validateInput(c,{production:true}),/real_input/);
});
test('fixed POST inference uses own bearer token; no URL/prompt/model/schema or operation reads',async()=>{
 const input=await materialized(),t=task(),calls=[];const body={purpose:'content.internal_draft',operation_key:D.operationKey(t.task_id,D.hashJson(input)),task_id:t.task_id,request_hash:D.hashJson(t),input_hash:D.hashJson(input),phase:'generate',lease_id:'l'.repeat(43)};
 const infer=D.createDraftInference({token:TOKEN,purpose:'content.internal_draft'},async(url,opts)=>{calls.push({url,opts});return response({status:'completed',json:artifact(input,t)});});
 await infer(body);assert.equal(calls.length,1);assert.equal(calls[0].url,D.CORE_ORIGIN+'/v1/infer');assert.equal(calls[0].opts.redirect,'error');assert.equal(calls[0].opts.headers.Authorization,'Bearer '+TOKEN);assert.ok(!calls[0].opts.headers['X-Operation-Token']);
 for(const extra of [{model:'bad'},{purpose:'director.review'},{url:'https://example.com'}])await assert.rejects(infer({...body,...extra}));assert.equal(calls.length,1);
});
test('only exact authoritative pre-execution429 receives safe-busy code',async()=>{
 const input=await materialized(),t=task(),body={purpose:'content.internal_draft',operation_key:D.operationKey(t.task_id,D.hashJson(input)),task_id:t.task_id,request_hash:D.hashJson(t),input_hash:D.hashJson(input),phase:'generate',lease_id:'l'.repeat(43)};
 for(const [r,code] of [[{status:'not_started',error:{code:'busy_before_inference'}},'draft_busy_not_started'],[{status:'not_started',error:{code:'rate_limit'}},'draft_inference_unconfirmed'],[{status:'not_started',error:{code:'busy_before_inference'},extra:true},'draft_inference_unconfirmed']])await assert.rejects(D.createDraftInference({token:TOKEN,purpose:'content.internal_draft'},async()=>response(r,429))(body),e=>e.code===code);
});
test('both roles freeze first, call once, submit core-generated artifact unchanged privately',async()=>{
 for(const agent of ['content','avitolog']){
  const c=core(task(seed(agent)));let infers=0,returned;
  const result=await D.processDraftClaim({...c,now:()=>AT,materialize:async()=>materialized(agent),infer:async body=>{infers++;assert.equal(c.state.status,'running');assert.deepEqual(Object.keys(body).sort(),['purpose','operation_key','task_id','request_hash','input_hash','phase','lease_id'].sort());returned=artifact(c.state.input,c.claim.task);return{status:'completed',json:returned};}});
  assert.equal(result.outcome,'submitted');assert.equal(infers,1);assert.deepEqual(c.state.artifact,returned);assert.equal(c.state.artifact.publication_authorized,false);assert.ok(c.calls.every(x=>/^\/operations\/tasks\/ot_/.test(x.path)));
 }
});
test('unknown inference never retries; forged provenance/financial text rejected before result write',async()=>{
 for(const mode of ['unknown','provenance','price','hash']){
  const c=core();let n=0;await assert.rejects(D.processDraftClaim({...c,now:()=>AT,materialize:async()=>materialized(),infer:async()=>{n++;if(mode==='unknown')throw new Error('network uncertain');const a=artifact(c.state.input,c.claim.task);if(mode==='provenance')a.provenance.task_id='ot_'+'9'.repeat(64);if(mode==='price')a.financial_source_strings=['999'];if(mode==='hash')a.provenance.output_hash='0'.repeat(64);return{status:'completed',json:a};}}));assert.equal(n,1);assert.ok(!c.calls.some(x=>x.path.endsWith('/result')));
 }
});
test('only preexecution busy retries identical body and lease within bounded remaining time',async()=>{
 const c=core();let n=0,clock=Date.parse(AT),bodies=[];
 await D.processDraftClaim({...c,now:()=>new Date(clock).toISOString(),sleep:async ms=>{assert.equal(ms,5000);clock+=ms;},materialize:async()=>materialized(),infer:async body=>{bodies.push(clone(body));if(++n===1)throw Object.assign(new Error('busy'),{code:'draft_busy_not_started'});return{status:'completed',json:artifact(c.state.input,c.claim.task)};}});
 assert.equal(n,2);assert.deepEqual(bodies[0],bodies[1]);
});
test('short leases, missing source, changed immutable intent never call inference',async()=>{
 for(const mode of ['lease','source','changed']){
 const c=core();if(mode==='lease')c.claim.lease_until='2026-10-17T14:02:00.000Z';let n=0;
 await assert.rejects(D.processDraftClaim({...c,now:()=>AT,materialize:async()=>{const v=await materialized();if(mode==='source')v.snapshots.project=null;if(mode==='changed')v.selection.plot_number='5';return v;},infer:async()=>{n++;throw Error('must not call');}}));assert.equal(n,0);}
});
test('uncertain result readback reconciles without another infer or result write',async()=>{
 const c=core();const original=c.request;let n=0;
 c.request=async(method,path,body)=>{const out=await original(method,path,body);if(path.endsWith('/result'))throw new Error('lost response');return out;};
 const result=await D.processDraftClaim({...c,now:()=>AT,materialize:async()=>materialized(),infer:async()=>{n++;return{status:'completed',json:artifact(c.state.input,c.claim.task)};}});
 assert.equal(result.outcome,'submitted');assert.equal(n,1);assert.equal(c.calls.filter(x=>x.path.endsWith('/result')).length,1);
});

test('Content existing worker routes new kind only to scoped draft helper',async()=>{
 const {processContentOperation}=require('../work-preparation/operation-worker');const c=core();let n=0;
 const request=async(method,path,body)=>path.endsWith('/claim')?c.claim:c.request(method,path,body);
 const result=await processContentOperation({request,readCalendar:()=>assert.fail('calendar'),now:()=>AT,draft:{materialize:async()=>materialized(),infer:async()=>{n++;return{status:'completed',json:artifact(c.state.input,c.claim.task)};}}});
 assert.equal(result.outcome,'submitted');assert.equal(n,1);
 const blocked=core();await assert.rejects(processContentOperation({request:async(m,p,b)=>p.endsWith('/claim')?blocked.claim:blocked.request(m,p,b),now:()=>AT}),/draft_disabled/);
});

test('repeated authoritative busy with a static clock stops after twelve safe retries',async()=>{
 const c=core();let calls=0,sleeps=0,modelCalls=0;
 await assert.rejects(D.processDraftClaim({...c,now:()=>AT,sleep:async ms=>{assert.equal(ms,5000);sleeps++;},materialize:async()=>materialized(),infer:async()=>{calls++;throw Object.assign(new Error('not started'),{code:'draft_busy_not_started'});}}),e=>e.code==='draft_busy_retry_limit');
 assert.equal(calls,13);assert.equal(sleeps,12);assert.equal(modelCalls,0);assert.ok(!c.calls.some(x=>x.path.endsWith('/result')));
});
