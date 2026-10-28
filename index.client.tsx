import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RequestCard } from "./client/card";
import { SettingsScreen } from "./client/settings";
import { CARD_KIND, CARD_VERSION, CardDataSchema } from "./shared/card";
import { readDiagnostics } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const removeRenderer = client.addTimelineRenderer({
    kind: CARD_KIND,
    version: CARD_VERSION,
    schema: CardDataSchema,
    Component: RequestCard,
  });
  const removeSettings = client.addSettingsScreen({ id: "main", title: "Secure input", icon: "ShieldCheck", Component: SettingsScreen });

  // The daemon half only receives its API handle inside a hook or an RPC. One
  // harmless call when the app loads lets it publish cards that were waiting.
  // A call that throws on the spot must not fail the whole contribution.
  try {
    void client.rpc(readDiagnostics, {}).catch(() => undefined);
  } catch {
    // nothing to do: the cards are published the next time the plugin is asked for anything
  }

  return () => {
    removeRenderer();
    removeSettings();
  };
}
