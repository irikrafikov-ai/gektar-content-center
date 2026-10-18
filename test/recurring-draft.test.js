const SOURCE_PATH='../work-preparation';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require(SOURCE_PATH + '/text-draft.cjs');
const S = require(SOURCE_PATH + '/text-draft-sources.cjs');
const at='2026-10-18T09:00:00Z';
function input(agent='content') {
 const f=(fact_id,quote)=>({fact_id,text:quote,quote,source_record_id:'synthetic-row'});
 const out=D.seedInput({kind:agent+'.text_draft.prepare',evaluatedAt:at});
 delete out.pilot_id;Object.assign(out,{schema_version:'text_draft.input.v2',regime_id:'marketing-production-20261018-v1',authorization_id:'marketing-production-grant-20261018-v1',cycle_date:'2026-10-18'});
 const data={inventory:{project_id:'sb',plot_number:'4',status_raw:'Свободен',area_raw:'7.82',price_raw:'310454',currency:'RUB'},project:{project_id:'sb',facts:[f('project_name','Учебный посёлок'),f('location','Тестовая область')]},cadastre:{project_id:'sb',plot_number:'4',cadastral_number:'71:22:0101010:444',area_raw:'7.82',facts:[f('identity','Учебный участок 4')]}};
 for(const [name,value]of Object.entries(data))out.snapshots[name]={source_ref:D.SOURCE_REFS[name],revision:'f'.repeat(64),observed_at:at,source_modified_at:null,sha256:D.hashJson(value),data:value};
 return out;
}
function artifact(t,v){
 const raw={items:Array.from({length:v.output.count},(_,i)=>({id:'item-'+i,title:'Учебный посёлок',body:'Учебный посёлок. Тестовая область. '+'Обсудите ваши пожелания и задайте вопросы, чтобы спокойно выбрать подходящий вариант. '.repeat(8)+i,claims:[{text:'Учебный посёлок',source_id:D.SOURCE_REFS.project,fact_id:'project_name',quote:'Учебный посёлок'},{text:'Тестовая область',source_id:D.SOURCE_REFS.project,fact_id:'location',quote:'Тестовая область'}]})),uncertainties:[],excluded_claims:[]},h=D.hashJson(v);
 return{schema_version:D.ARTIFACT_VERSION,kind:t.kind,status:'generated',publication_authorized:false,input_hash:h,...raw,financial_source_strings:['310454'],provenance:{task_id:t.task_id,request_hash:D.hashJson(t),operation_key:D.operationKey(t.task_id,h),purpose:t.agent+'.internal_draft',request_id:'req_'+'a'.repeat(64),thread_id:'synthetic-thread',model:'synthetic-model',input_hash:h,output_hash:D.hashJson(raw),prompt_version:D.PROMPT_VERSION,schema_hash:D.hashJson(D.MODEL_SCHEMA)}};
}
test('production v2 coexists with unchanged v1 and never accepts rotating grant',()=>{
 const v=input();D.validateInput(v,{complete:true,production:true,now:at});
 D.validateInput(D.seedInput({kind:v.kind,evaluatedAt:at}));
 for(const [key,value]of [['authorization_id','rotated'],['regime_id','rotated'],['pilot_id',D.PILOT_ID]]){const c=structuredClone(v);c[key]=value;assert.throws(()=>D.validateInput(c));}
});
test('production cycle uses Moscow date and cannot backdate',()=>{
 const v=input();v.cycle_date='2026-10-17';assert.throws(()=>D.validateInput(v,{now:at}),/draft_production_cycle_invalid/);
 const n=input();n.evaluated_at='2026-10-18T21:00:00Z';n.cycle_date='2026-10-19';for(const s of Object.values(n.snapshots))if(s)s.observed_at=n.evaluated_at;
 D.validateInput(n,{now:n.evaluated_at});
});
test('production fresh materialization retains grant and frozen KB; only inventory fetched',async()=>{
 const v=input();v.snapshots.inventory=null;let calls=0;
 const result=await S.materializeTextDraftInput(v,{observedAt:at,readSource:async type=>{calls++;assert.equal(type,'inventory');return{text:'Номер,Статус,Площадь,Цена\n4,Свободен,7.82,310454',modifiedAt:null};}});
 assert.equal(calls,1);assert.equal(result.authorization_id,v.authorization_id);assert.deepEqual(result.snapshots.project,v.snapshots.project);
 const old=structuredClone(v);old.snapshots.project.observed_at='2026-10-16T09:00:00Z';await assert.rejects(S.materializeTextDraftInput(old,{observedAt:at,readSource:async()=>{throw Error('must not fetch');}}),/draft_source_binding_invalid/);
});
test('production actual consumer runs finished-copy result with unchanged exact-purpose body',async()=>{
 for(const agent of ['content','avitolog']){
  const v=input(agent),seed=structuredClone(v);seed.snapshots.inventory=null;
  const t={task_id:'ot_'+'a'.repeat(64),kind:v.kind,agent,payload:seed,deadline:'2026-10-18T10:00:00Z',work:{acceptance:v.kind+'.v1'}};
  const hash=D.hashJson(t),lease='l'.repeat(43),state={task:t,request_hash:hash,input:null,input_hash:null,status:'accepted'};let calls=0;
  const request=async(method,path,body)=>{
   if(method==='GET')return state;
   if(path.endsWith('/input')){state.input=body.input;state.input_hash=D.hashJson(body.input);state.status='running';return{task_id:t.task_id,request_hash:hash,input_hash:state.input_hash,status:'running'};}
   if(path.endsWith('/result'))return{task_id:t.task_id,request_hash:hash,input_hash:state.input_hash,status:'submitted',artifact_hash:D.hashJson(body.artifact)};
   throw Error('unexpected route');
  };
  const result=await D.processDraftClaim({claim:{task:t,request_hash:hash,lease_id:lease,lease_until:'2026-10-18T09:05:00Z'},request,materialize:async()=>v,now:()=>at,infer:async body=>{
   calls++;assert.deepEqual(Object.keys(body).sort(),['purpose','operation_key','task_id','request_hash','input_hash','phase','lease_id'].sort());assert.equal(body.purpose,agent+'.internal_draft');return{status:'completed',json:artifact(t,v)};
  }});
  assert.equal(result.outcome,'submitted');assert.equal(calls,1);
 }
});
test('production unknown inference never retries',async()=>{
 const v=input(),seed=structuredClone(v);seed.snapshots.inventory=null;const t={task_id:'ot_'+'b'.repeat(64),kind:v.kind,agent:'content',payload:seed,deadline:'2026-10-18T10:00:00Z',work:{acceptance:v.kind+'.v1'}},hash=D.hashJson(t);let calls=0;
 const state={task:t,request_hash:hash,input:v,input_hash:D.hashJson(v),status:'running'};
 await assert.rejects(D.processDraftClaim({claim:{task:t,request_hash:hash,lease_id:'l'.repeat(43),lease_until:'2026-10-18T09:05:00Z'},request:async(method)=>method==='GET'?state:{task_id:t.task_id,request_hash:hash,input_hash:state.input_hash,status:'running'},materialize:async()=>v,now:()=>at,infer:async()=>{calls++;throw Object.assign(new Error('unknown'),{code:'draft_inference_unknown'});}}),/unknown/);
 assert.equal(calls,1);
});
