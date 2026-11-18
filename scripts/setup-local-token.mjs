import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
if (!process.env.MCP_TEST_TOKEN || process.env.MCP_TEST_TOKEN === 'replace-me') {
  const source = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8') : '';
  writeFileSync(
    '.dev.vars',
    source.replace(/^MCP_TEST_TOKEN\s*=.*$/m, '').trimEnd() +
      '\nMCP_TEST_TOKEN="' +
      randomBytes(32).toString('hex') +
      '"\n',
  );
  console.log('Token MCP local gerado em .dev.vars; valor oculto.');
} else console.log('Token MCP já configurado; valor oculto.');
