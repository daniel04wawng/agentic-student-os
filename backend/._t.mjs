import fs from "node:fs"; import { createRequire } from "node:module";
const require=createRequire(process.cwd()+"/x.js"); const pg=require("pg");
const env=Object.fromEntries(fs.readFileSync(".env","utf8").split("\n").filter(l=>l&&!l.startsWith("#")&&l.includes("=")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i),l.slice(i+1)];}));
const pool=new pg.Pool({connectionString:env.DATABASE_URL});
const db={async query(t,p){const r=await pool.query(t,p);return{rows:r.rows};}};
// warm modal
const H={Authorization:`Bearer ${env.MODAL_MODEL_TOKEN}`};
for(let i=0;i<20;i++){const r=await fetch(env.MODAL_MODEL_URL+"/v1/models",{headers:H});if(r.ok)break;await new Promise(r=>setTimeout(r,5000));}
const { ModalModelProvider }=await import("./dist/model/modal.js");
const { ModelService }=await import("./dist/model/service.js");
const { EventBus }=await import("./dist/events/bus.js");
const { prepareClass }=await import("./dist/classprep/prep.js");
const model=new ModelService(new ModalModelProvider(env.MODAL_MODEL_URL, env.MODAL_MODEL_TOKEN, env.MODEL_NAME));
// delete + regen Supply Chains preps
const co=(await db.query("select id from courses where source_id=\x277118\x27")).rows[0].id;
await db.query("delete from class_preps where course_id=$1",[co]);
await db.query("delete from notifications where subject_id in (select id from sessions where course_id=$1)",[co]);
const s=(await db.query("select id, title, to_char(starts_at,\x27YYYY-MM-DD\x27) d from sessions where course_id=$1 and starts_at>=now() order by starts_at limit 1",[co])).rows[0];
const p=await prepareClass(db,new EventBus(db),model,s.id);
console.log("=== Supply Chains prep ("+s.d+") ===");
console.log("OVERVIEW:",(p.overview||"").slice(0,240));
console.log("KEY POINTS:",(p.key_points||[]).slice(0,4).join(" | "));
console.log("ANALYSIS:",(p.analysis||"").slice(0,260));
await pool.end();
