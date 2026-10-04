const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/migrate-integration-secrets.js');
function configuration(dir) { return { ...process.env, NODE_ENV:'production', SESSION_SECRET:'Session_key_0123456789_abcdefghijklmnopqrstuvwxyz', AUTOMATION_SECRET_KEY:'Encryption_key_9876543210_ABCDEFGHIJKLMNOPQRSTUVWXYZ', AUTOMATION_SECRET_KEY_ID:'new-key', SESSION_STORE_DIR:dir, APP_ORIGINS:'https://app.example.com', COOKIE_SAME_SITE:'lax', TRUST_PROXY:'false' }; }
test('offline secret migration preflights, backs up plaintext privately and is idempotent',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'libreflow-secret-upgrade-'));
  try {
    const file=path.join(dir,'webhooks.json');fs.writeFileSync(file,JSON.stringify([{id:'fixture',secretEncrypted:'synthetic secret fixture'}]));
    const env=configuration(dir);
    const dry=spawnSync(process.execPath,[script,dir],{env,encoding:'utf8'});assert.equal(dry.status,0);assert.equal(JSON.parse(dry.stdout).records,1);assert.equal(JSON.parse(fs.readFileSync(file))[0].secretEncrypted,'synthetic secret fixture');
    const applied=spawnSync(process.execPath,[script,dir,'--apply'],{env,encoding:'utf8'});assert.equal(applied.status,0);assert.equal(applied.stdout.includes('synthetic secret'),false);
    const encrypted=JSON.parse(fs.readFileSync(file))[0].secretEncrypted;assert.equal(encrypted.version,2);assert.equal(encrypted.keyId,'new-key');
    const backup=fs.readdirSync(dir).find(name=>name.includes('before-secret-migration'));assert.ok(backup);assert.equal(fs.statSync(path.join(dir,backup)).mode&0o777,0o600);
    const again=spawnSync(process.execPath,[script,dir,'--apply'],{env,encoding:'utf8'});assert.equal(again.status,0);assert.equal(JSON.parse(again.stdout).records,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('invalid old encryption fails before modifying any collection',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'libreflow-secret-invalid-'));
  try {
    const file=path.join(dir,'connectors.json');const original=JSON.stringify([{credentialsEncrypted:'synthetic fixture'}]);fs.writeFileSync(file,original);
    fs.writeFileSync(path.join(dir,'webhooks.json'),JSON.stringify([{secretEncrypted:{version:99}}]));
    const result=spawnSync(process.execPath,[script,dir,'--apply'],{env:configuration(dir),encoding:'utf8'});assert.equal(result.status,1);assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(fs.readdirSync(dir).length,2);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
