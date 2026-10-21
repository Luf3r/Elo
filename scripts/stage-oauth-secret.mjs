import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
if(existsSync('.dev.vars'))process.loadEnvFile('.dev.vars');
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
assert.equal(config.name,'elo-agendor-mcp');
assert.equal(config.vars.ACCESS_CLIENT_ID,'example-client-id');
const value=process.env.ACCESS_CLIENT_SECRET;
assert(value && value!=='replace-me' && value.length>=24 && !/\s/.test(value),'Configure ACCESS_CLIENT_SECRET locally; do not paste it in chat.');
// Stages a version, preserving deployed code/traffic. The subsequent code upload inherits the latest version's secret.
const child=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','versions','secret','bulk','--name',config.name,'--message','Stage Access OIDC secret for OAuth'],{input:JSON.stringify({ACCESS_CLIENT_SECRET:value}),encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
let output=String(child.stdout??'')+String(child.stderr??'');
for(const key of ['ACCESS_CLIENT_SECRET','AGENDOR_CRM_TOKEN','MCP_TEST_TOKEN'])if(process.env[key])output=output.split(process.env[key]).join('[REDACTED]');
process.stdout.write(output);process.exitCode=child.status??1;
