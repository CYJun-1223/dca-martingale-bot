// loadEnv (apps/server/env.js): the .env format the runner, the dashboard and bot.js all read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { loadEnv } = require('../apps/server/env');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soxx-env-test-'));
try {
  // no .env at all: nothing happens
  loadEnv(dir);

  fs.writeFileSync(path.join(dir, '.env'), [
    '# a comment', '', 'T_PLAIN=abc', 'T_SPACED =  padded value  ', 'T_DOUBLE="quoted"', "T_SINGLE='single'", 'T_EMPTY=',
    'T_EXISTING=from-file', 'lower_case=ignored', 'T_EQUALS=a=b=c', '  T_INDENT=ok', '',
  ].join('\r\n')); // Windows line endings, like the real file
  process.env.T_EXISTING = 'from-shell';
  loadEnv(dir);
  assert.strictEqual(process.env.T_PLAIN, 'abc');
  assert.strictEqual(process.env.T_SPACED, 'padded value');
  assert.strictEqual(process.env.T_DOUBLE, 'quoted');
  assert.strictEqual(process.env.T_SINGLE, 'single');
  assert.strictEqual(process.env.T_EQUALS, 'a=b=c');
  assert.strictEqual(process.env.T_INDENT, 'ok');
  assert.strictEqual(process.env.T_EXISTING, 'from-shell', 'a variable that is already set wins');
  assert.strictEqual(process.env.lower_case, undefined, 'only UPPER_CASE names are read');
  assert.strictEqual(process.env.T_EMPTY, '', 'an empty value stays empty');
  console.log('env: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of ['T_PLAIN', 'T_SPACED', 'T_DOUBLE', 'T_SINGLE', 'T_EMPTY', 'T_EXISTING', 'T_EQUALS', 'T_INDENT', 'lower_case']) delete process.env[k];
}
