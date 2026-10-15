// The app reuses plain JS from the dashboard (apps/web/src/lib) and the bot's order math (apps/server/dca.mjs),
// so Metro has to watch the whole apps/ folder, not just this one.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'mjs'])];
// shared files live outside this folder: resolve their imports from this app's node_modules
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
module.exports = config;
