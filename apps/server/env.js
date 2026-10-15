// .env loader (no dependencies), shared by the runner, the dashboard and the bot.js command line.
// Reads KEY=value lines from <root>/.env into process.env; a variable that is already set wins. Quotes around a value are removed.
const fs = require('fs');
const path = require('path');

function loadEnv(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

module.exports = { loadEnv };
