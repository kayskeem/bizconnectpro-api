const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Exclude the api directory and server.js from React Native bundling
// The api directory and server.js contain server-side code that should only run on Railway
config.resolver.blockList = [
  /api\/.*/,
  /server\.js/,
  ...config.resolver.blockList || [],
];

module.exports = config;
