import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { messages, type Translate } from "../client/messages";

/** The SDK's real translator, with a fixed locale so that assertions do not depend on the machine. */
export function translate(locale = "en"): Translate {
  const runtime = new PluginTranslationRuntime({ getLocale: () => locale, subscribe: () => () => undefined });
  return (key, ...args) => runtime.t(messages, key, ...args);
}
