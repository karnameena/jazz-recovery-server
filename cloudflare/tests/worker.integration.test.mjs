import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here=path.dirname(fileURLToPath(import.meta.url));
const migration = [
  "0001_initial_d1.sql",
  "0002_device_push_tokens.sql",
].map((file) => fs.readFileSync(path.resolve(here, "../../migrations/cloudflare", file), "utf8")).join("\n");

class Statement {
  constructor(db,sql,values=[]){this.db=db;this.sql=sql;this.values=values;}
  bind(...values){return new Statement(this.db,this.sql,values);}
  async first(){return this.db.sqlite.prepare(this.sql).get(...this.values)||null;}
  async all(){return {results:this.db.sqlite.prepare(this.sql).all(...this.values)};}
  async run(){const result=this.db.sqlite.prepare(this.sql).run(...this.values);return {meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid||0)}};}
}
class D1Mock {
  constructor(){this.sqlite=new DatabaseSync(":memory:");this.sqlite.exec(migration);}
  prepare(sql){return new Statement(this,sql);}
  async batch(statements){
    this.sqlite.exec("BEGIN");
    try{const results=[];for(const statement of statements)results.push(await statement.run());this.sqlite.exec("COMMIT");return results;}
    catch(error){this.sqlite.exec("ROLLBACK");throw error;}
  }
}
const DB=new D1Mock();
const env={
  DB,WEB_ORIGIN:"https://jazzrecovery.com",TRIAL_DAYS:"7",
  TRIAL_CLAIM_PEPPER:"test-only-pepper-not-for-production",
  JAZZ_OWNER_ADMIN_BOOTSTRAP_SECRET:"owner-bootstrap-test-secret-0123456789abcdef",
  JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET:"billing-bootstrap-test-secret-0123456789abcdef",
  JAZZ_DISCOUNT_CODE_PEPPER:"discount-test-pepper-0123456789abcdef",
};
const origin="https://jazzrecovery.com";
async function call(path,{method="GET",body,headers={}}={}){
  const h=new Headers(headers);
  if(method!=="GET"&&method!=="HEAD")h.set("Origin",origin);
  if(body!==undefined)h.set("Content-Type","application/json");
  return worker.fetch(new Request("https://api.jazzrecovery.com"+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)}),env);
}
async function data(response){return response.json();}

const health=await call("/health");
assert.equal(health.status,200);
assert.equal((await data(health)).database,"d1");

const deviceToken="abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const registered=await call("/api/auth/register",{method:"POST",body:{
  username:"Mama",password:"JazzStrongPassword123",recoveryPin:"1234",confirmRecoveryPin:"1234",
  deviceName:"Mama Phone",imei:"123456789012345",deviceId:"device-123456",deviceToken
}});
const reg=await data(registered);
assert.equal(registered.status,201,JSON.stringify(reg));
assert.equal(reg.trialActivated,true);
assert.ok(reg.device.id);
const duplicateRegistration=await call("/api/auth/register",{method:"POST",body:{
  username:"mama",password:"AnotherStrongPassword123",recoveryPin:"3333",confirmRecoveryPin:"3333",
  deviceName:"Duplicate",imei:"123456789012347",deviceId:"device-duplicate",deviceToken:"123456789012345678901234567890123456"
}});
assert.equal(duplicateRegistration.status,409);
const preflight=await worker.fetch(new Request("https://api.jazzrecovery.com/api/auth/login",{method:"OPTIONS",headers:{Origin:origin,"Access-Control-Request-Method":"POST"}}),env);
assert.equal(preflight.status,204);

const login=await call("/api/auth/login",{method:"POST",body:{username:"mama",password:"JazzStrongPassword123"}});
assert.equal(login.status,200);
const cookie=login.headers.get("set-cookie").split(";")[0];
assert.ok(cookie.startsWith("__Host-jazz_lost_mode_session="));
assert.match(login.headers.get("set-cookie"),/HttpOnly/);
assert.match(login.headers.get("set-cookie"),/Secure/);
assert.match(login.headers.get("set-cookie"),/SameSite=Lax/);
const blockedOrigin=await worker.fetch(new Request("https://api.jazzrecovery.com/api/auth/session",{headers:{Origin:"https://evil.example"}}),env);
assert.equal(blockedOrigin.status,403);
const session=await call("/api/auth/session",{headers:{Cookie:cookie}});
assert.equal(session.status,200);
assert.equal((await data(session)).username,"Mama");

// Passkey registration options must be served by the Cloudflare Worker (not 404/501).
const passkeyOptions=await call("/api/auth/passkey/register/options",{method:"POST",headers:{Cookie:cookie},body:{}});
const passkeyOptionsData=await data(passkeyOptions);
assert.equal(passkeyOptions.status,200,JSON.stringify(passkeyOptionsData));
assert.ok(passkeyOptionsData.flowId);
assert.ok(passkeyOptionsData.options?.challenge);
assert.ok(DB.sqlite.prepare("SELECT 1 FROM webauthn_challenges WHERE flow_id=? AND purpose='register'").get(passkeyOptionsData.flowId));
const passkeyResetOptions=await call("/api/auth/password-reset/passkey/options",{method:"POST",body:{username:"Mama"}});
const passkeyResetOptionsData=await data(passkeyResetOptions);
assert.equal(passkeyResetOptions.status,200);
assert.equal(passkeyResetOptionsData.available,false);


const billing=await call("/api/billing/status",{headers:{Cookie:cookie}});
assert.equal(billing.status,200);
assert.equal((await data(billing)).access,"trial");
const adminUserId=DB.sqlite.prepare("SELECT id FROM users WHERE username='Mama'").get().id;
DB.sqlite.prepare("INSERT INTO billing_admins(user_id) VALUES(?)").run(adminUserId);
const adminBilling=await call("/api/billing/status",{headers:{Cookie:cookie}});
assert.equal((await data(adminBilling)).isBillingAdmin,true);

const devices=await call("/api/devices",{headers:{Cookie:cookie}});
assert.equal(devices.status,200);
const device=(await data(devices)).items[0];
assert.equal(device.location,null);
assert.equal(device.photo,null);

const secondReg=await call("/api/auth/register",{method:"POST",body:{
  username:"OtherUser",password:"OtherStrongPassword123",recoveryPin:"2222",confirmRecoveryPin:"2222",
  deviceName:"Other Phone",imei:"123456789012346",deviceId:"device-other-123",deviceToken:"ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210"
}});
assert.equal(secondReg.status,201);
const secondLogin=await call("/api/auth/login",{method:"POST",body:{username:"OtherUser",password:"OtherStrongPassword123"}});
const secondCookie=secondLogin.headers.get("set-cookie").split(";")[0];
const forbiddenDevice=await call(`/api/devices/${device.id}`,{headers:{Cookie:secondCookie}});
assert.equal(forbiddenDevice.status,404);

const heartbeat=await call("/android/device/heartbeat",{method:"POST",headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},body:{
  deviceId:"device-123456",mode:"NORMAL_MODE",status:{battery:85,charging:false,network:"WIFI",locationServices:"ON"},
  lastKnownLocation:{ok:true,latitude:13.0827,longitude:80.2707,accuracyMeters:10,timestamp:Date.now()}
}});
assert.equal(heartbeat.status,200);
const detail=await call(`/api/devices/${device.id}`,{headers:{Cookie:cookie}});
const detailData=await data(detail);
assert.equal(detail.status,200);
assert.equal(detailData.device.location.latitude,13.0827);
assert.ok(detailData.device.location.relayId);
const locationRelayId=detailData.device.location.relayId;
const ack=await call(`/api/devices/${device.id}/recovery-relay/ack`,{method:"POST",headers:{Cookie:cookie},body:{relayId:locationRelayId}});
assert.equal(ack.status,200);
const afterAck=await call(`/api/devices/${device.id}`,{headers:{Cookie:cookie}});
assert.equal((await data(afterAck)).device.location,null);
assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM recovery_result_relays").get().n,0);
assert.equal(DB.sqlite.prepare("PRAGMA table_info(device_state)").all().some(row=>row.name==="latitude"),false);

// FCM registration is authenticated with the existing paired-device credential.
const fcmToken = "fcm-registration-token-012345678901234567890";
const fcmRegistration = await call("/android/device/push-token", {
  method: "POST",
  headers: {"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},
  body: {fcmToken, platform:"android"},
});
assert.equal(fcmRegistration.status, 200);
assert.equal((await data(fcmRegistration)).registered, true);
assert.equal(
  DB.sqlite.prepare("SELECT fcm_token FROM device_push_tokens WHERE device_id=?").get(device.id).fcm_token,
  fcmToken,
);
const invalidFcmRegistration = await call("/android/device/push-token", {
  method: "POST",
  headers: {"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},
  body: {fcmToken:"short"},
});
assert.equal(invalidFcmRegistration.status, 400);

// Lost Mode queues a background-safe command and reports FCM configuration separately.
// A missing FCM secret must not discard or fail the owner-authorized command.
const lostModeAction = await call(`/api/devices/${device.id}/actions`, {
  method:"POST",
  headers:{Cookie:cookie},
  body:{action:"SET_RECOVERY_MODE",args:{enabled:true}},
});
const lostModeQueued = await data(lostModeAction);
assert.equal(lostModeAction.status, 202);
assert.equal(lostModeQueued.status, "QUEUED");
assert.equal(lostModeQueued.wake.status, "NOT_CONFIGURED");
const lostModeNext = await call("/android/device/commands/next", {
  headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},
});
assert.equal((await data(lostModeNext)).command.id, lostModeQueued.commandId);
const lostModeAck = await call(`/android/device/commands/${lostModeQueued.commandId}/result`, {
  method:"POST",
  headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},
  body:{result:{ok:true,mode:"LOST_MODE"}},
});
assert.equal(lostModeAck.status, 200);
const lostModeRead = await call(`/api/devices/${device.id}/commands/${lostModeQueued.commandId}`, {
  headers:{Cookie:cookie},
});
assert.equal((await data(lostModeRead)).status, "CONFIRMED");
const lostModeDevice = await call(`/api/devices/${device.id}`, {headers:{Cookie:cookie}});
assert.equal((await data(lostModeDevice)).device.mode, "LOST_MODE");

// A background-safe poll must skip foreground-only commands without leasing them.
const foregroundQueued = await call(`/api/devices/${device.id}/actions`, {
  method:"POST", headers:{Cookie:cookie}, body:{action:"RING_DEVICE",args:{durationMs:10000}},
});
assert.equal(foregroundQueued.status, 202);
const foregroundCommandId = (await data(foregroundQueued)).commandId;
const backgroundLostModeQueued = await call(`/api/devices/${device.id}/actions`, {
  method:"POST", headers:{Cookie:cookie}, body:{action:"SET_RECOVERY_MODE",args:{enabled:false}},
});
assert.equal(backgroundLostModeQueued.status, 202);
const backgroundLostModeId = (await data(backgroundLostModeQueued)).commandId;
const backgroundPoll = await call("/android/device/commands/next?backgroundSafe=1", {
  headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},
});
const backgroundPollData = await data(backgroundPoll);
assert.equal(backgroundPoll.status, 200);
assert.equal(backgroundPollData.command.id, backgroundLostModeId);
assert.equal(backgroundPollData.command.type, "set_recovery_mode");
const foregroundStillPending = DB.sqlite.prepare("SELECT status,leased_until FROM recovery_commands WHERE id=?").get(foregroundCommandId);
assert.equal(foregroundStillPending.status, "pending");
assert.equal(foregroundStillPending.leased_until, null);
const backgroundLostModeAck = await call(`/android/device/commands/${backgroundLostModeId}/result`, {
  method:"POST", headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},
  body:{result:{ok:true,mode:"NORMAL_MODE"}},
});
assert.equal(backgroundLostModeAck.status, 200);
const foregroundPoll = await call("/android/device/commands/next", {
  headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},
});
assert.equal((await data(foregroundPoll)).command.id, foregroundCommandId);
const foregroundAck = await call(`/android/device/commands/${foregroundCommandId}/result`, {
  method:"POST", headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},
  body:{result:{ok:true}},
});
assert.equal(foregroundAck.status, 200);

const queued=await call(`/api/devices/${device.id}/actions`,{method:"POST",headers:{Cookie:cookie},body:{action:"GET_LOCATION"}});
assert.equal(queued.status,202);
const commandId=(await data(queued)).commandId;
const queuedDuplicate=await call(`/api/devices/${device.id}/actions`,{method:"POST",headers:{Cookie:cookie},body:{action:"GET_LOCATION"}});
assert.equal(queuedDuplicate.status,202);
assert.equal((await data(queuedDuplicate)).commandId,commandId);
const next=await call("/android/device/commands/next",{headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`}});
assert.equal(next.status,200);
const command=(await data(next)).command;
assert.equal(command.id,commandId);
assert.equal(command.type,"device_location");

const result=await call(`/android/device/commands/${commandId}/result`,{method:"POST",headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},body:{result:{ok:true,latitude:13.09,longitude:80.28,accuracyMeters:5,timestamp:Date.now()}}});
assert.equal(result.status,200);
const locationDetail=await call(`/api/devices/${device.id}`,{headers:{Cookie:cookie}});
assert.equal((await data(locationDetail)).device.location.longitude,80.28);

// Confirmed Location Services OFF must be immediately reflected by the device read API.
const locationOffAction=await call(`/api/devices/${device.id}/actions`,{method:"POST",headers:{Cookie:cookie},body:{action:"LOCATION_DISABLE"}});
assert.equal(locationOffAction.status,202);
const locationOffCommandId=(await data(locationOffAction)).commandId;
const locationOffNext=await call("/android/device/commands/next",{headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`}});
assert.equal((await data(locationOffNext)).command.id,locationOffCommandId);
const locationOffResult=await call(`/android/device/commands/${locationOffCommandId}/result`,{method:"POST",headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},body:{result:{ok:true,confirmed:true,locationServices:"OFF",timestamp:Date.now()}}});
assert.equal(locationOffResult.status,200);
const locationOffStatus=await call(`/api/devices/${device.id}`,{headers:{Cookie:cookie}});
assert.equal((await data(locationOffStatus)).device.locationServices,"OFF");

const photoAction=await call(`/api/devices/${device.id}/actions`,{method:"POST",headers:{Cookie:cookie},body:{action:"RECOVERY_PHOTO",args:{camera:"rear"}}});
assert.equal(photoAction.status,202);
const photoCommand=(await data(photoAction)).commandId;
const nextPhoto=await call("/android/device/commands/next",{headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`}});
assert.equal((await data(nextPhoto)).command.id,photoCommand);
const photoResult=await call(`/android/device/commands/${photoCommand}/result`,{method:"POST",headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},body:{result:{ok:true,camera:"rear",mimeType:"image/png",imageBase64:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",timestamp:Date.now()}}});
assert.equal(photoResult.status,200);
const photoDetail=await call(`/api/devices/${device.id}`,{headers:{Cookie:cookie}});
const photoData=(await data(photoDetail)).device.photo;
assert.ok(photoData.dataUrl.startsWith("data:image/png;base64,"));
assert.equal(photoData.camera,"rear");
const photoRelayRow=DB.sqlite.prepare("SELECT payload_json FROM recovery_result_relays WHERE kind='photo'").get();
assert.ok(photoRelayRow?.payload_json?.includes("data:image/png;base64,"));
const photoAck=await call(`/api/devices/${device.id}/recovery-relay/ack`,{method:"POST",headers:{Cookie:cookie},body:{relayId:photoData.relayId}});
assert.equal(photoAck.status,200);

assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM recovery_result_relays WHERE kind='photo'").get().n,0);
const storedCommand=DB.sqlite.prepare("SELECT result_json FROM recovery_commands WHERE id=?").get(photoCommand);
assert.equal(storedCommand.result_json.includes("imageBase64"),false);


DB.sqlite.prepare("UPDATE device_state SET mode='LOST_MODE' WHERE device_id=?").run(device.id);
const beaconResponse=await call("/android/device/beacon",{method:"POST",headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`}});
assert.equal(beaconResponse.status,200);
const beacon=(await data(beaconResponse)).beaconToken;
assert.equal(beacon.length,14);
const encounterId=crypto.randomUUID();
const encounterResponse=await call("/android/helper/encounters",{method:"POST",headers:{"X-Jazz-Lost-Device-Id":"device-other-123",Authorization:"Bearer ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210"},body:{
  beaconToken:beacon,encounterId,observedAt:Date.now(),locationTimestamp:Date.now(),
  latitude:13.1,longitude:80.3,accuracyMeters:18,locationSource:"phone_b_fused",locationFresh:true
}});
assert.equal(encounterResponse.status,201);
const helperLocations=await call(`/api/devices/${device.id}/helper-locations`,{headers:{Cookie:cookie}});
const helperItems=(await data(helperLocations)).items;
assert.equal(helperLocations.status,200);
assert.equal(helperItems.length,1);
assert.equal(helperItems[0].locationType,"HELPER_PHONE_LOCATION_ESTIMATE");
DB.sqlite.prepare("UPDATE recovery_helper_encounters SET expires_at='2000-01-01 00:00:00' WHERE encounter_id=?").run(encounterId);
const ctx={waitUntil(promise){this.promise=promise;}};
worker.scheduled({},env,ctx);
await ctx.promise;
assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM recovery_helper_encounters").get().n,0);

const pinUpdate=await call("/api/auth/recovery-pin",{method:"POST",headers:{Cookie:cookie},body:{currentPassword:"JazzStrongPassword123",recoveryPin:"5678",confirmRecoveryPin:"5678"}});
assert.equal(pinUpdate.status,200);
const reset=await call("/api/auth/forgot-password",{method:"POST",body:{username:"Mama",recoveryPin:"5678",newPassword:"JazzNewPassword456"}});
assert.equal(reset.status,200);
const oldSession=await call("/api/auth/session",{headers:{Cookie:cookie}});
assert.equal(oldSession.status,401);
const newLogin=await call("/api/auth/login",{method:"POST",body:{username:"Mama",password:"JazzNewPassword456"}});
assert.equal(newLogin.status,200);

const replacementToken="NEW_DEVICE_TOKEN_012345678901234567890123456789";
const repair=await call("/api/auth/device-repair",{method:"POST",body:{
  username:"Mama",password:"JazzNewPassword456",deviceId:"device-123456",deviceToken:replacementToken,
  deviceName:"Mama Phone Repaired",imei:"123456789012345"
}});
assert.equal(repair.status,200);
const oldTokenHeartbeat=await call("/android/device/heartbeat",{method:"POST",headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${deviceToken}`},body:{deviceId:"device-123456",status:{}}});
assert.equal(oldTokenHeartbeat.status,401);
const newTokenHeartbeat=await call("/android/device/heartbeat",{method:"POST",headers:{"X-Jazz-Lost-Device-Id":"device-123456",Authorization:`Bearer ${replacementToken}`},body:{deviceId:"device-123456",status:{}}});
assert.equal(newTokenHeartbeat.status,200);


// Fresh admin bootstrap using existing users/billing_admins/billing_audit tables only.
DB.sqlite.prepare("DELETE FROM billing_admins WHERE user_id=(SELECT id FROM users WHERE username='Mama')").run();
const ownerWrongSecret=await call("/api/admin/bootstrap/owner",{method:"POST",body:{
  username:"guna_owner",password:"OwnerStrongPassword123",bootstrapSecret:"wrong-secret"
}});
assert.equal(ownerWrongSecret.status,401);
const ownerCreated=await call("/api/admin/bootstrap/owner",{method:"POST",body:{
  username:"guna_owner",password:"OwnerStrongPassword123",bootstrapSecret:env.JAZZ_OWNER_ADMIN_BOOTSTRAP_SECRET
}});
assert.equal(ownerCreated.status,201,JSON.stringify(await data(ownerCreated)));
const ownerDuplicate=await call("/api/admin/bootstrap/owner",{method:"POST",body:{
  username:"guna_owner",password:"OwnerStrongPassword456",bootstrapSecret:env.JAZZ_OWNER_ADMIN_BOOTSTRAP_SECRET
}});
assert.equal(ownerDuplicate.status,409);
const ownerLogin=await call("/api/auth/login",{method:"POST",body:{username:"guna_owner",password:"OwnerStrongPassword123"}});
assert.equal(ownerLogin.status,200);
const ownerCookie=ownerLogin.headers.get("set-cookie").split(";")[0];
// Admin datetime-local values are India local time; 06:00 IST must persist as 00:30 UTC.
const trialStartLocal="2026-11-04T06:00";
const trialEndLocal="2026-11-18T06:00";
const mamaTrialUpdate=await call(`/api/billing/admin/users/${adminUserId}/trial`,{method:"POST",headers:{Cookie:ownerCookie},body:{startsAt:trialStartLocal,expiresAt:trialEndLocal}});
assert.equal(mamaTrialUpdate.status,200,JSON.stringify(await data(mamaTrialUpdate)));
const savedTrial=DB.sqlite.prepare("SELECT starts_at,expires_at FROM billing_trials WHERE user_id=?").get(adminUserId);
assert.equal(savedTrial.starts_at,"2026-11-04 00:30:00");
assert.equal(savedTrial.expires_at,"2026-11-18 00:30:00");
const ownerUsers=await call("/api/owner/admin/users",{headers:{Cookie:ownerCookie}});
assert.equal(ownerUsers.status,200);
assert.ok((await data(ownerUsers)).items.some(item=>item.username==="guna_owner"));
const customerCookie=newLogin.headers.get("set-cookie").split(";")[0];
const customerOwnerForbidden=await call("/api/owner/admin/users",{headers:{Cookie:customerCookie}});
assert.equal(customerOwnerForbidden.status,403);

const billingWrongSecret=await call("/api/admin/bootstrap/billing",{method:"POST",body:{
  username:"guna_billing",password:"BillingStrongPassword123",bootstrapSecret:"wrong-secret"
}});
assert.equal(billingWrongSecret.status,401);
const billingCreated=await call("/api/admin/bootstrap/billing",{method:"POST",body:{
  username:"guna_billing",password:"BillingStrongPassword123",bootstrapSecret:env.JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET
}});
assert.equal(billingCreated.status,201,JSON.stringify(await data(billingCreated)));
const billingDuplicate=await call("/api/admin/bootstrap/billing",{method:"POST",body:{
  username:"guna_billing",password:"BillingStrongPassword456",bootstrapSecret:env.JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET
}});
assert.equal(billingDuplicate.status,409);
const billingLogin=await call("/api/auth/login",{method:"POST",body:{username:"guna_billing",password:"BillingStrongPassword123"}});
assert.equal(billingLogin.status,200);
const billingCookie=billingLogin.headers.get("set-cookie").split(";")[0];
const billingStatus=await call("/api/billing/status",{headers:{Cookie:billingCookie}});
assert.equal((await data(billingStatus)).isBillingAdmin,true);
const mamaId=DB.sqlite.prepare("SELECT id FROM users WHERE username='Mama'").get().id;
const grantBilling=await call("/api/owner/admin/billing-admins/grant",{method:"POST",headers:{Cookie:ownerCookie},body:{userId:mamaId}});
assert.equal(grantBilling.status,200);
const mamaBillingStatus=await call("/api/billing/status",{headers:{Cookie:customerCookie}});
assert.equal((await data(mamaBillingStatus)).isBillingAdmin,true);
const revokeBilling=await call("/api/owner/admin/billing-admins/revoke",{method:"POST",headers:{Cookie:ownerCookie},body:{userId:mamaId}});
assert.equal(revokeBilling.status,200);
const mamaBillingStatusAfterRevoke=await call("/api/billing/status",{headers:{Cookie:customerCookie}});
assert.equal((await data(mamaBillingStatusAfterRevoke)).isBillingAdmin,false);
const billingCodes=await call("/api/billing/admin/discount-codes",{headers:{Cookie:billingCookie}});
assert.equal(billingCodes.status,200);
const createdCode=await call("/api/billing/admin/discount-codes",{method:"POST",headers:{Cookie:billingCookie},body:{
  code:"MAMA20",label:"Test annual promotion",percentOff:20,startsAt:new Date(Date.now()-60000).toISOString(),
  expiresAt:new Date(Date.now()+86400000).toISOString(),maxRedemptions:10,perUserLimit:1,eligiblePlan:"annual",active:true
}});
assert.equal(createdCode.status,201,JSON.stringify(await data(createdCode)));
const validCode=await call("/api/billing/discount/validate",{method:"POST",headers:{Cookie:customerCookie},body:{code:"MAMA20",plan:"annual"}});
assert.equal(validCode.status,200);
assert.equal((await data(validCode)).valid,true);
const ledger=await call("/api/billing/admin/user-ledger",{headers:{Cookie:billingCookie}});
assert.equal(ledger.status,200);
const paymentIntents=await call("/api/billing/admin/payment-intents",{headers:{Cookie:billingCookie}});
assert.equal(paymentIntents.status,200);
const auditList=await call("/api/billing/admin/audit",{headers:{Cookie:billingCookie}});
assert.equal(auditList.status,200);
const subscriptions=await call("/api/billing/admin/subscriptions",{headers:{Cookie:billingCookie}});
assert.equal(subscriptions.status,200);
const payments=await call("/api/billing/admin/payments",{headers:{Cookie:billingCookie}});
assert.equal(payments.status,200);
const billingAdminCannotOwner=await call("/api/owner/admin/users",{headers:{Cookie:billingCookie}});
assert.equal(billingAdminCannotOwner.status,403);

// Server-side expiry is enforced even if the browser still has the cookie.
const expiringLogin=await call("/api/auth/login",{method:"POST",body:{username:"OtherUser",password:"OtherStrongPassword123"}});
assert.equal(expiringLogin.status,200);
const expiringCookie=expiringLogin.headers.get("set-cookie").split(";")[0];
const expiringToken=decodeURIComponent(expiringCookie.split("=")[1]);
const { createHash } = await import("node:crypto");
const expiringHash=createHash("sha256").update(expiringToken).digest("hex");
DB.sqlite.prepare("UPDATE sessions SET expires_at='2000-01-01 00:00:00' WHERE token_hash=?").run(expiringHash);
const expiredSession=await call("/api/auth/session",{headers:{Cookie:expiringCookie}});
assert.equal(expiredSession.status,401);

console.log("PASS: health, registration/duplicate rejection, CORS preflight, PBKDF2 login, secure session cookie, origin rejection, billing status/Admin bit, owner-only device access, Android heartbeat, authenticated FCM token registration/validation, Lost Mode queue + FCM-not-configured fallback + Android acknowledgement readback, temporary location relay + ACK, no D1 location persistence, command queue/lease/dedupe, Android location result, temporary D1 photo transport relay + ACK, no permanent photo storage, BLE beacon/helper location temporary retention + cleanup, PIN update, PIN password reset, passkey registration-options/challenge persistence and password-reset fallback, confirmed location OFF status readback, India-local trial-time normalization, explicit session expiry, session revocation, device token repair/rotation.");
