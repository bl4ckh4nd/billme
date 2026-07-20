const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Workspace packages use NodeNext .js specifiers while Metro reads their TypeScript sources.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
