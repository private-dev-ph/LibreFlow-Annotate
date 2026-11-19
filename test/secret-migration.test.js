const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/migrate-integration-secrets.js');
function configuration(dir) { return { ...process.env, NODE_ENV:'production', SESSION_SECRET:'Session_key_0123456789_abcdefghijklmnopqrstuvwxyz', AUTOMATION_SECRET_KEY:'Encryption_key_9876543210_ABCDEFGHIJKLMNOPQRSTUVWXYZ', AUTOMATION_SECRET_KEY_ID:'new-key', SESSION_STORE_DIR:dir, APP_ORIGINS:'https://app.example.com', COOKIE_SAME_SITE:'lax', TRUST_PROXY:'false' }; }
function assertPrivateBackup(file) {
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    return;
  }
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const inspectAcl = `
    $ErrorActionPreference = 'Stop'
    $sidType = [System.Security.Principal.SecurityIdentifier]
    $acl = [System.IO.File]::GetAccessControl($env:BACKUP_FIXTURE_PATH)
    $rules = foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
      @{
        sid = $rule.IdentityReference.Value
        allowed = $rule.AccessControlType -eq 'Allow'
        inherited = $rule.IsInherited
        fullControl = $rule.FileSystemRights -eq 'FullControl'
      }
    }
    @{
      currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      owner = $acl.GetOwner($sidType).Value
      protected = $acl.AreAccessRulesProtected
      rules = @($rules)
    } | ConvertTo-Json -Depth 4 -Compress
  `;
  const inspection = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', inspectAcl], {
    env: { SystemRoot: process.env.SystemRoot, BACKUP_FIXTURE_PATH: file },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(inspection.status, 0, inspection.stderr);
  const { currentUser, owner, protected: protectedAcl, rules } = JSON.parse(inspection.stdout);
  assert.equal(owner, currentUser);
  assert.equal(protectedAcl, true);
  assert.deepEqual(rules, [{ sid: currentUser, allowed: true, inherited: false, fullControl: true }]);
}
test('offline secret migration preflights, backs up plaintext privately and is idempotent',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'libreflow [secret backup] &'));
  try {
    const file=path.join(dir,'webhooks.json');const original=Buffer.from(JSON.stringify([{id:'fixture',secretEncrypted:'synthetic secret fixture'}]));fs.writeFileSync(file,original);
    const env=configuration(dir);
    const dry=spawnSync(process.execPath,[script,dir],{env,encoding:'utf8'});assert.equal(dry.status,0);assert.equal(JSON.parse(dry.stdout).records,1);assert.equal(JSON.parse(fs.readFileSync(file))[0].secretEncrypted,'synthetic secret fixture');
    const applied=spawnSync(process.execPath,[script,dir,'--apply'],{env,encoding:'utf8'});assert.equal(applied.status,0);assert.equal(applied.stdout.includes('synthetic secret'),false);
    const encrypted=JSON.parse(fs.readFileSync(file))[0].secretEncrypted;assert.equal(encrypted.version,2);assert.equal(encrypted.keyId,'new-key');
    const backup=fs.readdirSync(dir).find(name=>name.includes('before-secret-migration'));assert.ok(backup);assert.deepEqual(fs.readFileSync(path.join(dir,backup)), original);assertPrivateBackup(path.join(dir,backup));
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
