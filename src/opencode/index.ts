// OpenCode adapter (v2): the mesh plugin, its installer and the version check.
export { installPlugin, pluginStatus, uninstallPlugin, type PluginStatus } from "./installer.ts";
export { PLUGIN_MARKER, pluginSource, pluginVersionOf, type PluginOptions } from "./plugin.ts";
export { opencodeSupported, opencodeVersion } from "./version.ts";
