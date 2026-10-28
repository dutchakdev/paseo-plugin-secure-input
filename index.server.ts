import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defaultOptions, startPlugin } from "./server/paseo/plugin";

export default function contribute(server: PluginServerContext) {
  return startPlugin(server, defaultOptions()).dispose;
}
