import { sha256 } from "./security.js";
import { authenticateDevice } from "./android-routes.js";

const BEACON_TTL_MS=120000;
const MAX_ENCOUNTER_AGE_MS=120000;
const MAX_LOCATION_AGE_MS=900000;
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});}
function sqliteNow(ms=Date.now()){return new Date(ms).toISOString().slice(0,19).replace("T"," ");}
function iso(value){const raw=String(value||"");const d=new Date(raw.includes("T")?raw:`${raw.replace(" ","T")}Z`);return Number.isNaN(d.getTime())?raw:d.toISOString();}
async function readBody(request,maxBytes=16384){const raw=await request.text();if(new TextEncoder().encode(raw).byteLength>maxBytes)throw Object.assign(new Error("Request body is too large."),{status:413});try{return raw?JSON.parse(raw):{};}catch{throw Object.assign(new Error("Invalid JSON request."),{status:400});}}
function validCoordinate(value,min,max){return typeof value==="number"&&Number.isFinite(value)&&value>=min&&value<=max;}
function toBase64Url(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
async function audit(db,userId,deviceId,action,status){await db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,?,?,?)").bind(userId??null,deviceId??null,action,status).run();}

export async function handleBluetoothHelperRoutes(request,env,url){
  const db=env.DB;
  if(request.method==="POST"&&url.pathname==="/android/device/beacon"){
    const device=await authenticateDevice(db,request);
    if(!device)return json({ok:false,error:"Unauthorized device"},401);
    const state=await db.prepare("SELECT mode FROM device_state WHERE device_id=?").bind(device.id).first();
    if(state?.mode!=="LOST_MODE")return json({ok:false,error:"Lost Mode must be active on the server before issuing a beacon"},409);
    const raw=toBase64Url(crypto.getRandomValues(new Uint8Array(10)));
    const hash=await sha256(raw);
    const expiresAt=Date.now()+BEACON_TTL_MS;
    const statements=[
      db.prepare("DELETE FROM recovery_beacon_tokens WHERE device_id=? OR expires_at<=CURRENT_TIMESTAMP").bind(device.id),
      db.prepare("INSERT INTO recovery_beacon_tokens(token_hash,device_id,expires_at) VALUES(?,?,?)").bind(hash,device.id,sqliteNow(expiresAt)),
    ];
    await db.batch(statements);
    return json({ok:true,beaconToken:raw,expiresAt,serviceUuid:"b5b3c0a1-7c9e-4d12-9f40-4a415a5a5a01"});
  }

  if(request.method==="POST"&&url.pathname==="/android/helper/encounters"){
    const helper=await authenticateDevice(db,request);
    if(!helper)return json({ok:false,error:"Unauthorized helper device"},401);
    const body=await readBody(request);
    const beaconToken=String(body.beaconToken||"");
    const encounterId=String(body.encounterId||"");
    const observedAt=Number(body.observedAt);
    const locationTimestamp=Number(body.locationTimestamp);
    const latitude=Number(body.latitude),longitude=Number(body.longitude);
    const accuracy=body.accuracyMeters==null?null:Number(body.accuracyMeters);
    const now=Date.now();
    if(!/^[A-Za-z0-9_-]{14}$/.test(beaconToken)||!/^[0-9a-f-]{36}$/i.test(encounterId)||
      !Number.isSafeInteger(observedAt)||Math.abs(now-observedAt)>MAX_ENCOUNTER_AGE_MS||
      !Number.isSafeInteger(locationTimestamp)||locationTimestamp>now+30000||now-locationTimestamp>MAX_LOCATION_AGE_MS||
      !validCoordinate(latitude,-90,90)||!validCoordinate(longitude,-180,180)||
      (accuracy!==null&&(!Number.isFinite(accuracy)||accuracy<0||accuracy>10000))){
      return json({ok:false,error:"Invalid or stale helper encounter"},400);
    }
    const beacon=await db.prepare("SELECT device_id FROM recovery_beacon_tokens WHERE token_hash=? AND expires_at>CURRENT_TIMESTAMP").bind(await sha256(beaconToken)).first();
    if(!beacon)return json({ok:false,error:"Recovery beacon expired or unknown"},410);
    if(Number(beacon.device_id)===Number(helper.id))return json({ok:false,error:"A device cannot report itself as a helper encounter"},400);
    const target=await db.prepare("SELECT user_id FROM devices WHERE id=?").bind(beacon.device_id).first();
    if(!target)return json({ok:false,error:"Target device not found"},404);
    try{
      await db.prepare(`INSERT INTO recovery_helper_encounters(encounter_id,target_device_id,helper_device_id,latitude,longitude,accuracy_meters,location_timestamp,observed_at,location_source,location_fresh,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(encounterId,beacon.device_id,helper.id,latitude,longitude,accuracy,locationTimestamp,observedAt,
        String(body.locationSource||"phone_b_fused").slice(0,40),body.locationFresh===true&&now-locationTimestamp<=30000?1:0,sqliteNow(now+15*60*1000)).run();
    }catch(error){
      if(/UNIQUE|constraint/i.test(String(error?.message||"")))return json({ok:false,error:"Encounter already reported"},409);
      throw error;
    }
    await audit(db,target.user_id,beacon.device_id,"BLUETOOTH_HELPER_ENCOUNTER","RECEIVED");
    return json({ok:true,status:"RECEIVED",targetDeviceId:beacon.device_id,observedAt},201);
  }

  const ownerMatch=url.pathname.match(/^\/api\/devices\/(\d+)\/helper-locations$/);
  if(request.method==="GET"&&ownerMatch){
    const {getSession}=await import("./security.js");
    const session=await getSession(db,request);
    if(!session)return json({ok:false,error:"Authentication required"},401);
    const target=await db.prepare("SELECT id FROM devices WHERE id=? AND user_id=?").bind(Number(ownerMatch[1]),session.user_id).first();
    if(!target)return json({ok:false,error:"Device not found"},404);
    const result=await db.prepare(`SELECT e.encounter_id AS id,e.latitude,e.longitude,e.accuracy_meters AS accuracyMeters,
      e.location_timestamp AS locationTimestamp,e.observed_at AS observedAt,e.location_source AS locationSource,
      e.location_fresh AS locationFresh,e.received_at AS receivedAt,h.device_name AS helperDeviceName
      FROM recovery_helper_encounters e JOIN devices h ON h.id=e.helper_device_id
      WHERE e.target_device_id=? AND e.expires_at>CURRENT_TIMESTAMP
      ORDER BY e.received_at DESC LIMIT 25`).bind(target.id).all();
    const now=Date.now();
    const items=(result.results||[]).map(item=>{
      const ageMs=now-Number(item.locationTimestamp);
      const validAge=Number.isFinite(ageMs)&&ageMs>=0;
      return {...item,receivedAt:iso(item.receivedAt),ageMs:Number.isFinite(ageMs)?Math.max(0,ageMs):null,
        freshness:validAge&&ageMs<=30000?"FRESH_HELPER_REPORT":validAge&&ageMs<=MAX_LOCATION_AGE_MS?"RECENT_HELPER_REPORT":"STALE_HELPER_REPORT",
        locationType:"HELPER_PHONE_LOCATION_ESTIMATE"};
    });
    return json({ok:true,locationType:"HELPER_PHONE_LOCATION_ESTIMATE",items});
  }
  return null;
}
