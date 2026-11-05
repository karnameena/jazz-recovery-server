import { sha256 } from "./security.js";
import { sendFcmWake } from "./fcm.js";

const LOCATION_COMMANDS = new Set(["location_status","location_enable","location_disable"]);
const DEDUPE_COMMANDS = new Set(["device_status","device_location","recovery_photo","location_status","location_enable","location_disable","set_recovery_mode"]);
const MAX_PENDING = 20;
const LOCATION_TTL_MS = 120000;

function json(body,status=200,headers={}) {
  return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}});
}
async function readBody(request,maxBytes=2*1024*1024) {
  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>maxBytes) throw Object.assign(new Error("Request body is too large."),{status:413});
  try{return raw?JSON.parse(raw):{};}catch{throw Object.assign(new Error("Invalid JSON request."),{status:400});}
}
function sqliteNow(ms=Date.now()) { return new Date(ms).toISOString().slice(0,19).replace("T"," "); }
function iso(value) {
  if(!value)return null;
  const raw=String(value);
  const date=new Date(raw.includes("T")?raw:`${raw.replace(" ","T")}Z`);
  return Number.isNaN(date.getTime())?raw:date.toISOString();
}
function locationServices(value) { return value==="ON"||value==="OFF"?value:"UNKNOWN"; }
async function audit(db,userId,deviceId,action,status) {
  await db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,?,?,?)")
    .bind(userId??null,deviceId??null,action,status).run();
}
export async function authenticateDevice(db,request) {
  const deviceId=String(request.headers.get("x-jazz-lost-device-id")||"").trim();
  const authorization=String(request.headers.get("authorization")||"");
  const token=authorization.startsWith("Bearer ")?authorization.slice(7).trim():"";
  if(!deviceId||!token||deviceId.length>128||token.length<32||token.length>512)return null;
  const row=await db.prepare("SELECT * FROM devices WHERE device_id=?").bind(deviceId).first();
  if(!row)return null;
  const ip=request.headers.get("CF-Connecting-IP")||"unknown";
  const attempts=await db.prepare(`SELECT COUNT(*) AS total FROM auth_device_attempts
    WHERE device_id=? AND ip_key=? AND attempted_at>datetime('now','-1 minute')`).bind(row.id,ip).first();
  if(Number(attempts?.total||0)>=20)return null;
  const presented=await sha256(token);
  const expected=String(row.credential_hash||"");
  let mismatch=presented.length^expected.length;
  for(let i=0;i<Math.min(presented.length,expected.length);i++)mismatch|=presented.charCodeAt(i)^expected.charCodeAt(i);
  if(mismatch!==0){
    await db.prepare("INSERT INTO auth_device_attempts(device_id,ip_key) VALUES(?,?)").bind(row.id,ip).run();
    return null;
  }
  await db.prepare("DELETE FROM auth_device_attempts WHERE device_id=? AND ip_key=?").bind(row.id,ip).run();
  return row;
}
function validLocation(value) {
  if(!value||typeof value!=="object")return null;
  const latitude=Number(value.latitude),longitude=Number(value.longitude);
  const timestamp=Number(value.timestamp)||Date.now();
  const accuracy=value.accuracyMeters==null?null:Number(value.accuracyMeters);
  if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||
     !Number.isFinite(longitude)||longitude < -180||longitude > 180||
     !Number.isFinite(timestamp)||timestamp<=0||timestamp>Date.now()+300000||
     (accuracy!==null&&(!Number.isFinite(accuracy)||accuracy<0||accuracy>10000)))return null;
  return {latitude,longitude,accuracyMeters:accuracy,timestamp};
}
async function saveRelay(db,device,kind,{payload,timestamp}) {
  const old=await db.prepare("SELECT id FROM recovery_result_relays WHERE device_id=? AND kind=?").bind(device.id,kind).all();
  for(const row of old.results||[]){
    await db.prepare("DELETE FROM recovery_result_relays WHERE id=?").bind(row.id).run();
  }
  const id=crypto.randomUUID();
  const expires=sqliteNow(Date.now()+30*60*1000);
  await db.prepare(`INSERT INTO recovery_result_relays(id,owner_id,device_id,kind,object_key,payload_json,result_timestamp,expires_at)
    VALUES(?,?,?,?,NULL,?,?,?)`).bind(id,device.user_id,device.id,kind,JSON.stringify(payload),timestamp,expires).run();
}
async function saveLocationRelay(db,device,raw) {
  const location=validLocation(raw);
  if(!location)return false;
  await saveRelay(db,device,"location",{payload:location,timestamp:location.timestamp});
  return true;
}
function decodeBase64(value) {
  if(typeof value!=="string"||value.length>8*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return null;
  try {
    const binary=atob(value);
    if(binary.length===0||binary.length>6*1024*1024)return null;
    const bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return bytes;
  }catch{return null;}
}
async function savePhotoRelay(db,device,result) {
  const bytes=decodeBase64(result.imageBase64);
  // D1 is only a short-lived transport queue. Keep the individual row below
  // the conservative D1 row-size ceiling; the browser persists verified bytes
  // in IndexedDB immediately after retrieval.
  if(!bytes || bytes.length > 1200*1024)return false;
  const isPng=bytes.length>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47&&bytes[4]===0x0d&&bytes[5]===0x0a&&bytes[6]===0x1a&&bytes[7]===0x0a;
  const isJpeg=bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  if(!isPng&&!isJpeg)return false;
  const mime=isPng?"image/png":"image/jpeg";
  if(result.mimeType&&result.mimeType!==mime)return false;
  const payload={
    dataUrl:`data:${mime};base64,${result.imageBase64}`,
    camera:result.camera==="rear"?"rear":"front"
  };
  await saveRelay(db,device,"photo",{payload,timestamp:Number(result.timestamp)||Date.now()});
  return true;
}
function mapCommand(action,args={}) {
  switch(action){
    case "DEVICE_STATUS":return {type:"device_status",args:{}};
    case "LOCATION_STATUS":return {type:"location_status",args:{}};
    case "LOCATION_ENABLE":return {type:"location_enable",args:{}};
    case "LOCATION_DISABLE":return {type:"location_disable",args:{}};
    case "GET_LOCATION":return {type:"device_location",args:{}};
    case "RING_DEVICE":return {type:"ring_device",args:{durationMs:Math.min(60000,Math.max(5000,Number(args.durationMs||30000)))}};
    case "RECOVERY_PHOTO":return {type:"recovery_photo",args:{camera:args.camera==="rear"?"rear":"front"}};
    case "SET_RECOVERY_MODE":return {type:"set_recovery_mode",args:{enabled:args.enabled!==false}};
    case "PLAY_VOICE_MESSAGE":{
      if(args.mimeType!=="audio/wav"||typeof args.audioBase64!=="string")return null;
      const bytes=decodeBase64(args.audioBase64);
      if(!bytes||bytes.length<=44||bytes.length>900000)return null;
      const ascii=(start,end)=>String.fromCharCode(...bytes.subarray(start,end));
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      if(ascii(0,4)!=="RIFF"||ascii(8,12)!=="WAVE"||view.getUint16(20,true)!==1||
         view.getUint16(22,true)!==1||view.getUint32(24,true)!==16000||view.getUint16(34,true)!==16)return null;
      return {type:"play_voice_message",args:{mimeType:"audio/wav",audioBase64:args.audioBase64}};
    }
    default:return null;
  }
}
async function expireLocationCommands(db,deviceId) {
  await db.prepare(`UPDATE recovery_commands SET status='expired',completed_at=CURRENT_TIMESTAMP,leased_until=NULL
    WHERE device_id=? AND status='pending' AND type IN ('location_enable','location_disable','location_status')
    AND created_at < datetime('now','-120 seconds')`).bind(deviceId).run();
}
async function stateFromStatus(db,device,status={}) {
  const services=locationServices(status.locationServices);
  await db.prepare(`UPDATE device_state SET mode=COALESCE(?,mode),battery=?,charging=?,network=?,online=1,last_seen=CURRENT_TIMESTAMP,
    location_services_status=?,location_services_timestamp=?,updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
    .bind(device.mode||null,status.battery??null,status.charging?1:0,status.network||"UNKNOWN",services,
      services==="UNKNOWN"?null:(Number(status.locationServicesTimestamp)||Date.now()),device.id).run();
}
async function handleAction(request,env,url) {
  const db=env.DB;
  const match=url.pathname.match(/^\/api\/devices\/(\d+)\/actions$/);
  if(request.method!=="POST"||!match)return null;
  const session=(await import("./security.js")).getSession;
  const current=await session(db,request);
  if(!current)return json({ok:false,error:"Authentication required"},401);
  const device=await db.prepare("SELECT * FROM devices WHERE id=? AND user_id=?").bind(Number(match[1]),current.user_id).first();
  if(!device)return json({ok:false,error:"Device not found"},404);
  const body=await readBody(request);
  const action=String(body.action||"").toUpperCase();
  const mapped=mapCommand(action,body.args||{});
  if(!mapped)return json({ok:false,error:action==="PLAY_VOICE_MESSAGE"?"Invalid or oversized recovery voice message":"Recovery action is not allowed"},400);
  if(LOCATION_COMMANDS.has(mapped.type))await expireLocationCommands(db,device.id);
  if(mapped.type==="location_enable"||mapped.type==="location_disable"){
    const opposite=mapped.type==="location_enable"?"location_disable":"location_enable";
    const conflict=await db.prepare("SELECT id FROM recovery_commands WHERE device_id=? AND status='pending' AND type=? LIMIT 1").bind(device.id,opposite).first();
    if(conflict){await audit(db,current.user_id,device.id,action,"CONFLICT");return json({ok:false,error:"An opposite Location Services command is already pending. Refresh its result before changing direction."},409);}
  }
  if(DEDUPE_COMMANDS.has(mapped.type)){
    const pending=await db.prepare("SELECT id,args_json FROM recovery_commands WHERE device_id=? AND type=? AND status='pending' ORDER BY created_at LIMIT 20").bind(device.id,mapped.type).all();
    const same=(pending.results||[]).find(row=>{
      if(mapped.type!=="recovery_photo")return true;
      try{return (JSON.parse(row.args_json||"{}").camera||"front")===(mapped.args.camera||"front");}catch{return false;}
    });
    if(same){
      await audit(db,current.user_id,device.id,action,"COALESCED");
      const wake=mapped.type==="set_recovery_mode"
        ? await sendFcmWake(env,db,device,same.id)
        : null;
      return json({ok:true,commandId:same.id,status:"ALREADY_QUEUED",deduplicated:true,...(wake?{wake}:{})},202);
    }
  }
  const id=crypto.randomUUID();
  try{
    await db.prepare("INSERT INTO recovery_commands(id,device_id,type,args_json) VALUES(?,?,?,?)")
      .bind(id,device.id,mapped.type,JSON.stringify(mapped.args)).run();
  }catch(error){
    const msg=String(error?.message||"");
    if(msg.includes("opposite_location_command_pending"))return json({ok:false,error:"An opposite Location Services command is already pending. Refresh its result before changing direction."},409);
    if(msg.includes("too_many_pending_recovery_commands"))return json({ok:false,error:"Too many recovery commands are already pending for this device"},429,{"retry-after":"10"});
    if(msg.includes("duplicate_pending_recovery_command")){
      const existing=await db.prepare("SELECT id FROM recovery_commands WHERE device_id=? AND type=? AND status='pending' ORDER BY created_at LIMIT 1").bind(device.id,mapped.type).first();
      if(existing)return json({ok:true,commandId:existing.id,status:"ALREADY_QUEUED",deduplicated:true},202);
    }
    throw error;
  }
  await audit(db,current.user_id,device.id,action,"QUEUED");
  // Lost Mode is a background-safe command. FCM is only a wake-up hint:
  // the Android Companion still fetches the authenticated command and must
  // acknowledge it through /android/device/commands/{id}/result.
  const wake = mapped.type==="set_recovery_mode"
    ? await sendFcmWake(env,db,device,id)
    : null;
  return json({
    ok:true,
    commandId:id,
    status:"QUEUED",
    deduplicated:false,
    ...(wake?{wake}:{}),
  },202);
}
async function handleRelayAck(request,env,url) {
  const match=url.pathname.match(/^\/api\/devices\/(\d+)\/recovery-relay\/ack$/);
  if(request.method!=="POST"||!match)return null;
  const {getSession}=await import("./security.js");
  const session=await getSession(env.DB,request);
  if(!session)return json({ok:false,error:"Authentication required"},401);
  const device=await env.DB.prepare("SELECT id FROM devices WHERE id=? AND user_id=?").bind(Number(match[1]),session.user_id).first();
  if(!device)return json({ok:false,error:"Device not found"},404);
  const body=await readBody(request,4096);
  const relayId=String(body.relayId||"");
  if(!/^[a-f0-9-]{36}$/i.test(relayId))return json({ok:false,error:"Invalid recovery relay acknowledgement."},400);
  const relay=await env.DB.prepare("SELECT id,object_key FROM recovery_result_relays WHERE id=? AND owner_id=? AND device_id=?")
    .bind(relayId,session.user_id,device.id).first();
  if(!relay)return json({ok:true,acknowledged:false});
  await env.DB.prepare("DELETE FROM recovery_result_relays WHERE id=? AND owner_id=? AND device_id=?")
    .bind(relayId,session.user_id,device.id).run();
  return json({ok:true,acknowledged:true});
}

async function handleCommandResultRead(request,env,url) {
  const match=url.pathname.match(/^\/api\/devices\/(\d+)\/commands\/([a-f0-9-]{36})$/i);
  if(request.method!=="GET"||!match)return null;
  const {getSession}=await import("./security.js");
  const session=await getSession(env.DB,request);
  if(!session)return json({ok:false,error:"Authentication required"},401);
  const device=await env.DB.prepare("SELECT * FROM devices WHERE id=? AND user_id=?").bind(Number(match[1]),session.user_id).first();
  if(!device)return json({ok:false,error:"Device not found"},404);
  await expireLocationCommands(env.DB,device.id);
  const command=await env.DB.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?").bind(match[2],device.id).first();
  if(!command)return json({ok:false,error:"Command not found"},404);
  const result=command.result_json?JSON.parse(command.result_json):null;
  const desired=command.type==="location_enable"?"ON":command.type==="location_disable"?"OFF":null;
  const isConfirmed=command.status==="done"&&result?.ok===true&&(
    desired
      ? result.confirmed===true&&result.locationServices===desired
      : command.type==="location_status"
        ? ["ON","OFF"].includes(result.locationServices)
        : true
  );
  const state=await env.DB.prepare("SELECT last_seen FROM device_state WHERE device_id=?").bind(device.id).first();
  const online=Boolean(state?.last_seen&&Date.now()-Date.parse(String(state.last_seen).replace(" ","T")+"Z")<=90000);
  const status=isConfirmed?"CONFIRMED":command.status==="expired"?"EXPIRED":command.status==="done"?"FAILED":online?"PENDING":"DEVICE_OFFLINE";
  return json({ok:true,commandId:command.id,status,confirmed:isConfirmed,command:command.type,result,createdAt:iso(command.created_at),completedAt:iso(command.completed_at)});
}
async function handleAuditRead(request,env,url) {
  const match=url.pathname.match(/^\/api\/devices\/(\d+)\/audit$/);
  if(request.method!=="GET"||!match)return null;
  const {getSession}=await import("./security.js");
  const session=await getSession(env.DB,request);
  if(!session)return json({ok:false,error:"Authentication required"},401);
  const device=await env.DB.prepare("SELECT id FROM devices WHERE id=? AND user_id=?").bind(Number(match[1]),session.user_id).first();
  if(!device)return json({ok:false,error:"Device not found"},404);
  const rows=await env.DB.prepare("SELECT action,status,created_at FROM recovery_audit WHERE user_id=? AND device_id=? ORDER BY id DESC LIMIT 50").bind(session.user_id,device.id).all();
  return json({ok:true,items:(rows.results||[]).map(row=>({...row,created_at:iso(row.created_at)}))});
}
async function handleAndroid(request,env,url) {
  const db=env.DB;

  // Android Companion registers/refreshes its Firebase token using the same
  // device bearer credential as heartbeat and command polling.
  if(request.method==="POST"&&url.pathname==="/android/device/push-token"){
    const device=await authenticateDevice(db,request);
    if(!device)return json({ok:false,error:"Unauthorized device"},401);
    const body=await readBody(request,16*1024);
    const fcmToken=String(body.fcmToken||body.fcm_token||body.token||"").trim();
    if(fcmToken.length<20||fcmToken.length>4096||/[\u0000-\u001f\u007f\s]/.test(fcmToken)){
      return json({ok:false,error:"Invalid FCM registration token"},400);
    }
    const platform=String(body.platform||"android").toLowerCase();
    if(platform!=="android")return json({ok:false,error:"Unsupported push platform"},400);
    await db.prepare(`INSERT INTO device_push_tokens(device_id,fcm_token,platform,updated_at)
      VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(device_id) DO UPDATE SET
        fcm_token=excluded.fcm_token,
        platform=excluded.platform,
        updated_at=CURRENT_TIMESTAMP`)
      .bind(device.id,fcmToken,platform).run();
    return json({ok:true,registered:true});
  }

  if(request.method==="POST"&&url.pathname==="/android/device/heartbeat"){
    const device=await authenticateDevice(db,request);
    if(!device)return json({ok:false,error:"Unauthorized device"},401);
    const body=await readBody(request,256*1024);
    if(body.deviceId&&body.deviceId!==device.device_id)return json({ok:false,error:"Device identity mismatch"},403);
    const status=body.status&&typeof body.status==="object"?body.status:{};
    const services=locationServices(status.locationServices);
    await db.prepare(`UPDATE device_state SET mode=?,battery=?,charging=?,network=?,online=1,last_seen=CURRENT_TIMESTAMP,
      location_services_status=?,location_services_timestamp=?,updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
      .bind(body.mode||"NORMAL_MODE",status.battery??null,status.charging?1:0,status.network||"UNKNOWN",services,
        services==="UNKNOWN"?null:(Number(status.locationServicesTimestamp)||Date.now()),device.id).run();
    if(body.lastKnownLocation?.ok)await saveLocationRelay(db,device,body.lastKnownLocation);
    return json({ok:true,serverTime:Date.now()});
  }

  if(request.method==="GET"&&url.pathname==="/android/device/commands/next"){
    const device=await authenticateDevice(db,request);
    if(!device)return json({ok:false,error:"Unauthorized device"},401);
    await expireLocationCommands(db,device.id);
    const backgroundSafe = url.searchParams.get("backgroundSafe") === "1";
    const commandFilter = backgroundSafe
      ? " AND type IN ('set_recovery_mode')"
      : "";
    for(let attempt=0;attempt<5;attempt++){
      const row=await db.prepare(`SELECT * FROM recovery_commands WHERE device_id=? AND status='pending'
        AND (leased_until IS NULL OR leased_until<CURRENT_TIMESTAMP)${commandFilter}
        ORDER BY created_at LIMIT 1`).bind(device.id).first();
      if(!row)break;
      const leaseUntil=sqliteNow(Date.now()+30000);
      const updated=await db.prepare(`UPDATE recovery_commands SET leased_until=? WHERE id=? AND status='pending'
        AND (leased_until IS NULL OR leased_until<CURRENT_TIMESTAMP)`).bind(leaseUntil,row.id).run();
      if(Number(updated.meta?.changes||0)!==1)continue;
      const createdAtMs=Date.parse(String(row.created_at).replace(" ","T")+"Z");
      return json({ok:true,command:{id:row.id,type:row.type,args:JSON.parse(row.args_json||"{}"),
        createdAt:iso(row.created_at),...(LOCATION_COMMANDS.has(row.type)?{createdAtMs,expiresAtMs:createdAtMs+LOCATION_TTL_MS}:{})}});
    }
    return json({ok:true,command:null});
  }

  const resultMatch=url.pathname.match(/^\/android\/device\/commands\/([a-f0-9-]+)\/result$/i);
  if(request.method==="POST"&&resultMatch){
    const device=await authenticateDevice(db,request);
    if(!device)return json({ok:false,error:"Unauthorized device"},401);
    const body=await readBody(request,8*1024*1024);
    const result=body.result&&typeof body.result==="object"&&!Array.isArray(body.result)?body.result:{};
    const command=await db.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?").bind(resultMatch[1],device.id).first();
    if(!command)return json({ok:false,error:"Unknown recovery command"},404);
    if(LOCATION_COMMANDS.has(command.type)){
      await expireLocationCommands(db,device.id);
      const refreshed=await db.prepare("SELECT status FROM recovery_commands WHERE id=?").bind(command.id).first();
      if(refreshed?.status==="expired")return json({ok:false,error:"Location Services command expired"},409);
      if(refreshed?.status==="done")return json({ok:true,deduplicated:true});
    }
    let safeResult={ok:result.ok!==false};
    if(command.type==="device_status"){
      const status=result.status&&typeof result.status==="object"?result.status:{};
      const services=locationServices(status.locationServices);
      await db.prepare(`UPDATE device_state SET mode=?,battery=?,charging=?,network=?,online=1,last_seen=CURRENT_TIMESTAMP,
        location_services_status=?,location_services_timestamp=?,updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
        .bind(result.mode||"NORMAL_MODE",status.battery??null,status.charging?1:0,status.network||"UNKNOWN",services,
          services==="UNKNOWN"?null:(Number(status.locationServicesTimestamp)||Date.now()),device.id).run();
      if(result.lastKnownLocation?.ok)await saveLocationRelay(db,env,device,result.lastKnownLocation);
      safeResult={ok:result.ok!==false};
    }else if(command.type==="device_location"){
      if(result.ok===true){
        if(!await saveLocationRelay(db,device,result))return json({ok:false,error:"Device location failed validation."},400);
        safeResult={ok:true,timestamp:Number(result.timestamp)||Date.now()};
      }else safeResult={ok:false};
      await db.prepare("UPDATE device_state SET last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?").bind(device.id).run();
    }else if(LOCATION_COMMANDS.has(command.type)){
      const services=locationServices(result.locationServices);
      const expected=command.type==="location_enable"?"ON":command.type==="location_disable"?"OFF":null;
      const confirmed=result.ok===true&&(command.type==="location_status"?services!=="UNKNOWN":result.confirmed===true&&services===expected);
      if(confirmed)await db.prepare("UPDATE device_state SET location_services_status=?,location_services_timestamp=?,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?")
        .bind(services,Number(result.timestamp)||Date.now(),device.id).run();
      safeResult={ok:result.ok===true,confirmed:confirmed===true,locationServices:services,timestamp:Number(result.timestamp)||Date.now()};
    }else if(command.type==="set_recovery_mode"&&result.mode){
      await db.prepare("UPDATE device_state SET mode=?,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?").bind(result.mode,device.id).run();
      safeResult={ok:result.ok!==false,mode:result.mode};
    }else if(command.type==="recovery_photo"&&result.ok===true){
      if(!await savePhotoRelay(db,device,result))return json({ok:false,error:"Recovery photo relay is unavailable or the photo failed validation."},503);
      safeResult={ok:true,timestamp:Number(result.timestamp)||Date.now(),camera:result.camera==="rear"?"rear":"front"};
      await db.prepare("UPDATE device_state SET last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?").bind(device.id).run();
    }else{
      safeResult={ok:result.ok!==false};
    }
    await db.prepare(`UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL
      WHERE id=? AND device_id=? AND status='pending'`).bind(JSON.stringify(safeResult),command.id,device.id).run();
    await audit(db,device.user_id,device.id,command.type.toUpperCase(),result.ok===false?"FAILED":"SUCCESS");
    return json({ok:true});
  }
  return null;
}

export async function handleAndroidAndRecoveryRoutes(request,env,url) {
  const relayAck=await handleRelayAck(request,env,url);
  if(relayAck)return relayAck;
  const resultRead=await handleCommandResultRead(request,env,url);
  if(resultRead)return resultRead;
  const auditRead=await handleAuditRead(request,env,url);
  if(auditRead)return auditRead;
  const action=await handleAction(request,env,url);
  if(action)return action;
  return handleAndroid(request,env,url);
}
