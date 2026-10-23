'use strict';
// Bounded, authenticated Kie asset jobs. No publication, purchases or retries.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, timingSafeEqual} = require('node:crypto');
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail = (code,status=400) => {throw Object.assign(new Error(code),{status,code});};
const text = (x,n) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;
function validate(input) {
 if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'actions,brief,credit_cap,id,project,publication_authorized') fail('invalid_job');
 if (!/^[a-z0-9][a-z0-9_-]{7,79}$/.test(input.id) || !text(input.project,120) || !text(input.brief,12000) || input.publication_authorized !== false) fail('invalid_job');
 if (!Number.isFinite(input.credit_cap) || input.credit_cap <= 0 || input.credit_cap > 1100 || !Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 5) fail('invalid_budget');
 let videos=0,speeches=0,cost=0;
 const actions=input.actions.map(a=>{
  if (!a || typeof a !== 'object') fail('invalid_action');
  if (a.kind === 'video') {
   if (Object.keys(a).sort().join(',') !== 'image_url,kind,prompt' || !text(a.prompt,5000)) fail('invalid_video');
   let u;try{u=new URL(a.image_url);}catch{fail('invalid_image');}
   if(u.origin!=='https://gektar-content-center-production.up.railway.app' || !/^\/uploads\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp)$/.test(u.pathname) || u.search || u.hash || u.username || u.password) fail('invalid_image');
   videos++;cost+=255; return {...a,reserved_credits:255};
  }
  if(a.kind === 'speech') {
   if(Object.keys(a).sort().join(',') !== 'kind,text' || !text(a.text,1000)) fail('invalid_speech');
   speeches++;cost+=20; return {...a,reserved_credits:20};
  }
  fail('invalid_action');
 });
 if(videos>4 || speeches>1 || cost>input.credit_cap) fail('budget_exceeded');
 return {input:JSON.parse(JSON.stringify(input)),actions,estimated_credits:cost};
}
function createVideoJobs({directory,apiKey,fetchImpl=globalThis.fetch,now=()=>new Date().toISOString()}) {
 if(!path.isAbsolute(directory)) fail('invalid_storage');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 function file(id){if(!/^[a-z0-9][a-z0-9_-]{7,79}$/.test(id))fail('invalid_id');return path.join(directory,id+'.json');}
 function load(id){try{return JSON.parse(fs.readFileSync(file(id),'utf8'));}catch(e){if(e.code==='ENOENT')fail('job_not_found',404);throw e;}}
 function save(j){const p=file(j.id),tmp=p+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(j));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,p);}
 async function lock(id,fn){const p=file(id)+'.lock';try{fs.mkdirSync(p);}catch(e){if(e.code==='EEXIST')fail('job_busy',409);throw e;}try{return await fn();}finally{fs.rmdirSync(p);}}
 async function api(endpoint,body){
  if(!apiKey || typeof apiKey !== 'string')fail('kie_not_configured',503);
  const response=await fetchImpl('https://api.kie.ai'+endpoint,{method:body?'POST':'GET',headers:{authorization:'Bearer '+apiKey.trim(),'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(45000)});
  const raw=await response.text();if(raw.length>1024*1024)fail('kie_response_too_large',502);let j;try{j=JSON.parse(raw);}catch{fail('kie_invalid_response',502);}
  return {http:response.status,...j};
 }
 async function credits(){const r=await api('/api/v1/chat/credit');if(r.http!==200 || r.code!==200 || !Number.isFinite(r.data))fail('balance_unavailable',502);return {credits:r.data,observed_at:now()};}
 async function create(input){const v=validate(input);return lock(input.id,async()=>{let old;try{old=load(input.id);}catch(e){if(e.code!=='job_not_found')throw e;}if(old){if(old.request_hash!==hash(input))fail('idempotency_conflict',409);return old;}
  const j={id:input.id,receipt_id:'vr_'+hash(input),request_hash:hash(input),accepted_at:now(),status:'accepted',input:v.input,estimated_credits:v.estimated_credits,reserved_credits:0,actions:v.actions.map(a=>({...a,status:'accepted'}))};save(j);return j;});}
 async function start(id,index){return lock(id,async()=>{const j=load(id);const a=j.actions[index];if(!Number.isInteger(index)||!a)fail('invalid_index');if(a.status!=='accepted')return j;
  const b=await credits();if(b.credits<a.reserved_credits)fail('insufficient_prepaid_credits',409);if(j.reserved_credits+a.reserved_credits>j.input.credit_cap)fail('budget_exceeded',409);
  a.status='submitting';a.started_at=now();a.balance_before=b.credits;j.reserved_credits+=a.reserved_credits;j.status='running';save(j);
  let r;try{r=await api(a.kind==='video'?'/api/v1/veo/generate':'/api/v1/jobs/createTask',a.kind==='video'?{prompt:a.prompt,imageUrls:[a.image_url],model:'veo3',aspect_ratio:'9:16',enableFallback:false,enableTranslation:true,generationType:'FIRST_AND_LAST_FRAMES_2_VIDEO'}:{model:'elevenlabs/text-to-speech-multilingual-v2',input:{text:a.text,voice:'EkK5I93UQWFDigLMpZcX',language_code:'ru',stability:0.6,similarity_boost:0.75,style:0.15,speed:1,timestamps:false}});
   if(r.http===200&&r.code===200&&typeof r.data?.taskId==='string'){a.provider_task_id=r.data.taskId;a.status='submitted';}
   else {a.status='submission_rejected';a.provider_code=r.code??r.http;}
  }catch{a.status='submission_unknown';}save(j);return j;
 });}
 async function poll(id,index){return lock(id,async()=>{const j=load(id),a=j.actions[index];if(!Number.isInteger(index)||!a)fail('invalid_index');if(!a.provider_task_id || a.status==='completed')return j;
  const q=encodeURIComponent(a.provider_task_id);const r=await api(a.kind==='video'?'/api/v1/veo/record-info?taskId='+q:'/api/v1/jobs/recordInfo?taskId='+q);
  if(r.http!==200 || r.code!==200)return j;const d=r.data||{};let urls=[];try{urls=JSON.parse(d.resultJson||'{}').resultUrls||[];}catch{}
  if(a.kind==='video')urls=d.response?.resultUrls||d.videoInfo?.videoUrl&&[d.videoInfo.videoUrl]||urls;
  urls=urls.filter(u=>typeof u==='string'&&/^https:\/\//.test(u));
  if(urls.length){a.result_urls=urls;a.status=a.kind==='video'?'generated_720p':'completed';}
  else if([2,3,'fail','FAILED','error'].includes(d.successFlag??d.state??d.status)){a.status='failed';a.provider_code=d.errorCode??d.failCode??'generation_failed';}
  a.observed_at=now();j.status=j.actions.every(x=>x.status==='completed')?'assets_ready':j.actions.some(x=>['failed','submission_unknown','submission_rejected'].includes(x.status))?'blocked':'running';save(j);return j;
 });}
 async function hd(id,index){return lock(id,async()=>{const j=load(id),a=j.actions[index];if(!Number.isInteger(index)||!a||a.kind!=='video')fail('invalid_index');if(a.status==='completed')return j;if(a.status!=='generated_720p'&&a.status!=='hd_pending')fail('video_not_ready',409);
  a.status='hd_pending';save(j);const r=await api('/api/v1/veo/get-1080p-video?taskId='+encodeURIComponent(a.provider_task_id)+'&index=0');
  if(r.http===200&&r.code===200&&typeof r.data?.resultUrl==='string'&&r.data.resultUrl.startsWith('https://')){a.result_urls_1080p=[r.data.resultUrl];a.status='completed';a.finished_at=now();}
  j.status=j.actions.every(x=>x.status==='completed')?'assets_ready':'running';save(j);return j;
 });}
 return {create,load,start,poll,hd,credits};
}
function mountVideoJobs(app,{directory,token,apiKey,fetchImpl}) {
 const jobs=createVideoJobs({directory,apiKey,fetchImpl});
 app.use('/director/video-jobs',(req,res,next)=>{const got=req.headers['x-director-task-token'];if(typeof token!=='string'||token.length<32)return res.status(503).json({error:'video_jobs_disabled'});if(typeof got!=='string'||got.length>256||!timingSafeEqual(Buffer.from(hash(got)),Buffer.from(hash(token))))return res.status(401).json({error:'unauthorized'});res.set('Cache-Control','no-store');next();});
 const route=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){res.status(e.status||503).json({error:e.code||'video_job_unavailable'});}};
 app.get('/director/video-jobs/credits',route(()=>jobs.credits()));
 app.post('/director/video-jobs',route(req=>jobs.create(req.body)));
 app.get('/director/video-jobs/:id',route(req=>jobs.load(req.params.id)));
 for(const action of ['start','poll','hd'])app.post('/director/video-jobs/:id/:index/'+action,route(req=>jobs[action](req.params.id,Number(req.params.index))));
 return jobs;
}
module.exports={validate,createVideoJobs,mountVideoJobs};
