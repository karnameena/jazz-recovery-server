import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {spawn} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {hashSecret} from "../src/auth/password.mjs";

const root = path.resolve(import.meta.dirname,"..");
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

async function freePort() {
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,"127.0.0.1",resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  return port;
}
test("authenticated Lost Mode heartbeat reports real location toggle status without modifying it", {timeout:45000},async t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"jazz-location-readback-"));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceKill);
          resolve();
        };
        const forceKill = setTimeout(() => {
          if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
        }, 3000);
        forceKill.unref();
        server.once("exit", finish);
        server.kill("SIGTERM");
      });
    }
    // On Windows, the SQLite file cannot be unlinked until the child process exits.
    fs.rmSync(temporary,{recursive:true,force:true});
  });
  const dbfile=path.join(temporary,"lost-mode.db");
  const db=new DatabaseSync(dbfile);
  const schema=fs.readFileSync(path.join(root,"migrations/001_initial.sql"),"utf8");
  db.exec(schema);
  const ownerPassword="TestOwnerPassword123!";
  const token=crypto.randomBytes(24).toString("hex");
  const owner=db.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)").run("test-owner",hashSecret(ownerPassword));
  const device=db.prepare("INSERT INTO devices(user_id,device_id,device_name,credential_hash) VALUES(?,?,?,?)")
    .run(Number(owner.lastInsertRowid),"test-companion","Test Device",hashSecret(token));
  const id=Number(device.lastInsertRowid);
  db.prepare("INSERT INTO device_state(device_id) VALUES(?)").run(id);
  db.close();
  const port=await freePort();
  const host="http://127.0.0.1:"+port;
  server=spawn(process.execPath,["src/server.mjs"],{
    cwd:root,
    env:{...process.env,PORT:String(port),LOST_MODE_DB_PATH:dbfile,LOST_MODE_COOKIE_SECURE:"false",
      LOST_MODE_PUBLIC_ORIGIN:"http://localhost:5190"},
    stdio:["ignore","pipe","pipe"]
  });
  let stderr="";
  server.stderr.on("data",d=>stderr+=String(d));
  let ready=false;
  for(let i=0;i<100;i++){
    if(server.exitCode!==null)break;
    try{const response=await fetch(host+"/health");if(response.ok){ready=true;break;}}catch{}
    await sleep(100);
  }
  assert.ok(ready,"Server didn't start: "+stderr);
  async function json(method,url,body,headers={}){
    const result=await fetch(host+url,{method,headers:{"Content-Type":"application/json",...headers},body:body?JSON.stringify(body):undefined});
    return {status:result.status,response:await result.json(),cookie:result.headers.get("set-cookie")};
  }
  const anonymousSession=await json("GET","/api/auth/session");
  assert.equal(anonymousSession.status,200,"A signed-out session check is a normal state, not an API error");
  assert.equal(anonymousSession.response.authenticated,false);

  const session=await json("POST","/api/auth/login",{username:"test-owner",password:ownerPassword});
  assert.equal(session.status,200);
  const cookie=session.cookie.split(";")[0];
  const authenticatedSession=await json("GET","/api/auth/session",undefined,{Cookie:cookie});
  assert.equal(authenticatedSession.status,200);
  assert.equal(authenticatedSession.response.authenticated,true);
  const ownerHeaders={Cookie:cookie};
  async function status(){return await json("GET","/api/devices/"+id,undefined,ownerHeaders);}
  let response=await status();
  assert.equal(response.response.device.locationServices,"OFFLINE");
  async function heartbeat(value){
    return await json("POST","/android/device/heartbeat",{
      deviceId:"test-companion",mode:"NORMAL_MODE",
      status:{online:true,network:"WIFI",battery:82,charging:false,locationServices:value,locationServicesTimestamp:Date.now()}
    },{"Authorization":"Bearer "+token,"X-Jazz-Lost-Device-Id":"test-companion"});
  }
  assert.equal((await heartbeat("ON")).status,200);
  response=await status();
  assert.equal(response.response.device.locationServices,"ON");
  assert.ok(response.response.device.locationServicesLastConfirmed);
  assert.equal((await heartbeat("OFF")).status,200);
  response=await status();
  assert.equal(response.response.device.locationServices,"OFF");
  assert.equal((await heartbeat("invalid")).status,200);
  response=await status();
  assert.equal(response.response.device.locationServices,"UNKNOWN");
  const unauthorized=await json("GET","/api/devices/"+id);
  assert.equal(unauthorized.status,401);
  const deviceHeaders={"Authorization":"Bearer "+token,"X-Jazz-Lost-Device-Id":"test-companion"};
  const actions="/api/devices/"+id+"/actions";
  const queued=await json("POST",actions,{action:"LOCATION_ENABLE"},ownerHeaders);
  assert.equal(queued.status,202);
  const enableId=queued.response.commandId;
  assert.ok(enableId);
  const duplicate=await json("POST",actions,{action:"LOCATION_ENABLE"},ownerHeaders);
  assert.equal(duplicate.response.commandId,enableId,"Duplicate should coalesce");
  assert.equal(duplicate.response.deduplicated,true);
  const conflict=await json("POST",actions,{action:"LOCATION_DISABLE"},ownerHeaders);
  assert.equal(conflict.status,409,"Opposite pending command must be rejected");
  let progress=await json("GET","/api/devices/"+id+"/commands/"+enableId,undefined,ownerHeaders);
  assert.equal(progress.response.status,"PENDING","Queuing must not imply success");
  const next=await json("GET","/android/device/commands/next",undefined,deviceHeaders);
  assert.equal(next.response.command.type,"location_enable");
  assert.equal(next.response.command.id,enableId);
  assert.ok(next.response.command.expiresAtMs>Date.now());
  const failed=await json("POST","/android/device/commands/"+enableId+"/result",{
    deviceId:"test-companion",result:{ok:false,confirmed:false,status:"DEVICE_OWNER_REQUIRED",locationServices:"OFF",error:"Not provisioned"}
  },deviceHeaders);
  assert.equal(failed.status,200);
  progress=await json("GET","/api/devices/"+id+"/commands/"+enableId,undefined,ownerHeaders);
  assert.equal(progress.response.status,"FAILED");
  assert.equal(progress.response.confirmed,false);
  const retry=await json("POST","/android/device/commands/"+enableId+"/result",{
    deviceId:"test-companion",result:{ok:true,confirmed:true,status:"CONFIRMED",locationServices:"ON"}
  },deviceHeaders);
  assert.equal(retry.response.deduplicated,true,"Replay must not overwrite a failed result");

  const off=await json("POST",actions,{action:"LOCATION_DISABLE"},ownerHeaders);
  assert.equal(off.status,202);
  const offId=off.response.commandId;
  const deliver=await json("GET","/android/device/commands/next",undefined,deviceHeaders);
  assert.equal(deliver.response.command.type,"location_disable");
  const reported=await json("POST","/android/device/commands/"+offId+"/result",{
    deviceId:"test-companion",result:{ok:true,confirmed:true,status:"CONFIRMED",locationServices:"OFF",timestamp:Date.now()}
  },deviceHeaders);
  assert.equal(reported.status,200);
  progress=await json("GET","/api/devices/"+id+"/commands/"+offId,undefined,ownerHeaders);
  assert.equal(progress.response.status,"CONFIRMED");
  assert.equal(progress.response.result.locationServices,"OFF");
  response=await status();
  assert.equal(response.response.device.locationServices,"OFF");

  const statusQuery=await json("POST",actions,{action:"LOCATION_STATUS"},ownerHeaders);
  assert.equal(statusQuery.status,202);
  const queryId=statusQuery.response.commandId;
  const query=await json("GET","/android/device/commands/next",undefined,deviceHeaders);
  assert.equal(query.response.command.type,"location_status");
  await json("POST","/android/device/commands/"+queryId+"/result",{
    deviceId:"test-companion",result:{ok:true,locationServices:"OFF",timestamp:Date.now()}
  },deviceHeaders);
  const queryResult=await json("GET","/api/devices/"+id+"/commands/"+queryId,undefined,ownerHeaders);
  assert.equal(queryResult.response.status,"CONFIRMED");
  assert.equal(queryResult.response.result.locationServices,"OFF");

  const stale=await json("POST",actions,{action:"LOCATION_ENABLE"},ownerHeaders);
  assert.equal(stale.status,202);
  const expiredId=stale.response.commandId;
  const directDb=new DatabaseSync(dbfile);
  directDb.prepare("UPDATE recovery_commands SET created_at=? WHERE id=?")
    .run("2026-01-01 00:00:00",expiredId);
  directDb.close();
  progress=await json("GET","/api/devices/"+id+"/commands/"+expiredId,undefined,ownerHeaders);
  assert.equal(progress.response.status,"EXPIRED");
  const late=await json("POST","/android/device/commands/"+expiredId+"/result",{
    deviceId:"test-companion",result:{ok:true,confirmed:true,locationServices:"ON"}
  },deviceHeaders);
  assert.equal(late.status,409,"Expired commands must never apply late success");

  const unauthCommand=await json("GET","/api/devices/"+id+"/commands/"+offId);
  assert.equal(unauthCommand.status,401);
  const separateDb=new DatabaseSync(dbfile);
  separateDb.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)")
    .run("other-owner",hashSecret("OtherOwnerPassword123!"));
  separateDb.close();
  const other=await json("POST","/api/auth/login",{username:"other-owner",password:"OtherOwnerPassword123!"});
  assert.equal(other.status,200);
  const otherHeaders={Cookie:other.cookie.split(";")[0]};
  const forbidden=await json("GET","/api/devices/"+id+"/commands/"+offId,undefined,otherHeaders);
  assert.equal(forbidden.status,404,"Commands must not be visible to another owner");
  const forbiddenAction=await json("POST",actions,{action:"LOCATION_ENABLE"},otherHeaders);
  assert.equal(forbiddenAction.status,404,"Another account must not command this device");
  const existing=await json("POST",actions,{action:"RING_DEVICE"},ownerHeaders);

  // Recovery-photo success/failure status and byte validation regression coverage.
  const photoBase64="/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAAB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EF//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EF//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAwE/EF//2Q==";
  const jpegBytes=Buffer.from(photoBase64,"base64");
  assert.equal(jpegBytes[0],0xff); assert.equal(jpegBytes[1],0xd8);
  assert.equal(jpegBytes[jpegBytes.length-2],0xff); assert.equal(jpegBytes[jpegBytes.length-1],0xd9);
  const photoQueued=await json("POST",actions,{action:"RECOVERY_PHOTO",args:{camera:"front"}},ownerHeaders);
  assert.equal(photoQueued.status,202);
  const photoId=photoQueued.response.commandId;
  const photoNext=await json("GET","/android/device/commands/next",undefined,deviceHeaders);
  assert.equal(photoNext.response.command.id,photoId);
  const photoUpload=await json("POST","/android/device/commands/"+photoId+"/result",{
    deviceId:"test-companion",result:{ok:true,camera:"front",mimeType:"image/jpeg",imageBase64:photoBase64,timestamp:Date.now()}
  },deviceHeaders);
  assert.equal(photoUpload.status,200);
  const photoStatus=await json("GET","/api/devices/"+id+"/commands/"+photoId,undefined,ownerHeaders);
  assert.equal(photoStatus.status,200,"Photo status polling must not return 404");
  assert.equal(photoStatus.response.status,"COMPLETE");
  assert.equal(photoStatus.response.result.ok,true);
  assert.equal(photoStatus.response.result.imageBase64,undefined,"Status polling must not return large photo bytes");
  const storedPhotoDb=new DatabaseSync(dbfile);
  const storedPhoto=storedPhotoDb.prepare("SELECT photo_data_url,photo_camera FROM device_state WHERE device_id=?").get(id);
  assert.ok(storedPhoto.photo_data_url.startsWith("data:image/jpeg;base64,"));
  assert.equal(storedPhoto.photo_camera,"front");
  storedPhotoDb.close();

  const failedPhotoQueued=await json("POST",actions,{action:"RECOVERY_PHOTO",args:{camera:"rear"}},ownerHeaders);
  const failedPhotoId=failedPhotoQueued.response.commandId;
  const failedPhotoNext=await json("GET","/android/device/commands/next",undefined,deviceHeaders);
  assert.equal(failedPhotoNext.response.command.id,failedPhotoId);
  await json("POST","/android/device/commands/"+failedPhotoId+"/result",{
    deviceId:"test-companion",result:{ok:false,camera:"rear",status:"CAMERA_PERMISSION_REQUIRED",error:"CAMERA_PERMISSION_REQUIRED"}
  },deviceHeaders);
  const failedPhotoStatus=await json("GET","/api/devices/"+id+"/commands/"+failedPhotoId,undefined,ownerHeaders);
  assert.equal(failedPhotoStatus.response.status,"FAILED");
  assert.equal(failedPhotoStatus.response.result.error,"CAMERA_PERMISSION_REQUIRED");
  const afterFailedDb=new DatabaseSync(dbfile);
  const afterFailed=afterFailedDb.prepare("SELECT photo_data_url,photo_camera FROM device_state WHERE device_id=?").get(id);
  assert.equal(afterFailed.photo_data_url,storedPhoto.photo_data_url,"Failed capture must preserve last verified photo");
  assert.equal(afterFailed.photo_camera,"front");
  afterFailedDb.close();

  const invalidQueued=await json("POST",actions,{action:"RECOVERY_PHOTO",args:{camera:"front"}},ownerHeaders);
  const invalidId=invalidQueued.response.commandId;
  await json("GET","/android/device/commands/next",undefined,deviceHeaders);
  await json("POST","/android/device/commands/"+invalidId+"/result",{
    deviceId:"test-companion",result:{ok:true,camera:"front",mimeType:"image/jpeg",imageBase64:"bm90LWEtanBlZw==",timestamp:Date.now()}
  },deviceHeaders);
  const invalidStatus=await json("GET","/api/devices/"+id+"/commands/"+invalidId,undefined,ownerHeaders);
  assert.equal(invalidStatus.response.status,"FAILED","Invalid image bytes must not be accepted");
  assert.equal(invalidStatus.response.result.error,"PHOTO_BYTES_INVALID");
  assert.equal(existing.status,202,"Existing ring device command must still queue");
  // Registration must work on SQLite as well as PostgreSQL, and must be atomic.
  const registeredToken=crypto.randomBytes(32).toString("base64url");
  const registrationBody={
    username:"new-recovery-owner",
    password:"RecoveryOwner123!",
    deviceName:"Recovery Test Phone",
    imei:"123456789012345",
    deviceId:"jazz-recovery-test",
    deviceToken:registeredToken
  };
  const registration=await json("POST","/api/auth/register",registrationBody);
  assert.equal(registration.status,201,"SQLite registration should create an owner and pair its device");
  assert.equal(registration.response.device.imei,"123456789012345");
  assert.equal(registration.response.device.deviceId,"jazz-recovery-test");
  const registrationCookie=registration.cookie.split(";")[0];
  const registrationSession=await json("GET","/api/auth/session",undefined,{Cookie:registrationCookie});
  assert.equal(registrationSession.status,200,"Registration should create a usable owner session");
  const registeredDevice=await json("GET","/api/devices/"+registration.response.device.id,undefined,{Cookie:registrationCookie});
  assert.equal(registeredDevice.status,200);
  assert.equal(registeredDevice.response.device.imei,"123456789012345");
  const registeredHeartbeat=await json("POST","/android/device/heartbeat",{
    deviceId:"jazz-recovery-test",mode:"NORMAL_MODE",status:{battery:78,network:"WIFI"}
  },{"Authorization":"Bearer "+registeredToken,"X-Jazz-Lost-Device-Id":"jazz-recovery-test"});
  assert.equal(registeredHeartbeat.status,200,"New device credential must authenticate");

  const duplicateUsername=await json("POST","/api/auth/register",{
    ...registrationBody,username:"NEW-RECOVERY-OWNER",deviceId:"another-recovery-device",
    deviceToken:crypto.randomBytes(32).toString("base64url")
  });
  assert.equal(duplicateUsername.status,409,"Username uniqueness must be case-insensitive");
  const duplicateDevice=await json("POST","/api/auth/register",{
    ...registrationBody,username:"second-recovery-owner",deviceName:"Second Phone",
    deviceToken:crypto.randomBytes(32).toString("base64url")
  });
  assert.equal(duplicateDevice.status,409,"A device token ID must not be paired twice");
  const invalidImei=await json("POST","/api/auth/register",{
    ...registrationBody,username:"invalid-imei-owner",deviceId:"invalid-imei-device",
    imei:"not-an-imei",deviceToken:crypto.randomBytes(32).toString("base64url")
  });
  assert.equal(invalidImei.status,400,"Invalid IMEI must be rejected before writing data");

});
