const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const yaml=require('js-yaml');
test('local Compose keeps trusted inference internal and wires production fail-closed settings',()=>{
 const {services}=yaml.load(fs.readFileSync('docker-compose.yml','utf8'));
 assert.equal(services.inference.ports,undefined);
 for(const service of ['app','postgres'])assert.ok(services[service].ports.every(port=>port.startsWith('127.0.0.1:')));
 for(const key of ['NODE_ENV','AUTOMATION_SECRET_KEY','AUTOMATION_SECRET_KEY_ID','APP_ORIGINS','SESSION_STORE_DIR','COOKIE_SAME_SITE','TRUST_PROXY'])assert.ok(key in services.app.environment,key);
 assert.equal(services.app.environment.SESSION_SECRET,'${SESSION_SECRET:-}');
 assert.equal(services.app.environment.AUTOMATION_SECRET_KEY,'${AUTOMATION_SECRET_KEY:-}');
});
