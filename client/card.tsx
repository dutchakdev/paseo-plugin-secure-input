import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text } from "react-native";
import type { CardData } from "../shared/card";
import { RequestDialog } from "./dialog";
import { MONO } from "./fields";
import { A11Y, PILL_HEIGHT, pill, pillColor } from "./presentation";
import { tone } from "./tone";

/** The moment the form was opened, or null while it is closed. */
type Opening = number | null;

/**
 * The pill in the agent's chat: a shield, the title and the keys, in one row of one height. Its look comes
 * from the timeline row alone, which holds names and state (agents can read it), and nothing that happens in the form
 * reaches it: the chat's list does not take a row whose height changes, and it unmounts rows while it scrolls
 * (getpaseo/paseo#7486). Only a pill that waits can be pressed; it opens the form, which reads the request itself. The
 * host has already checked `item.data` against the strict schema given at registration.
 */
export function RequestCard({ item, theme, host, layout }: PluginTimelineItemProps<CardData>) {
  const colors = tone(theme.colors);
  const [session, setSession] = useState<Opening>(null);
  const look = pill(item.data);
  const { color, opacity } = pillColor(look.tone, colors);

  return (
    <>
      <Pressable
        accessibilityRole={look.pressable ? "button" : undefined}
        accessibilityLabel={look.pressable ? A11Y.enter : undefined}
        disabled={!look.pressable}
        onPress={() => setSession(Date.now())}
        style={{
          height: PILL_HEIGHT,
          borderRadius: PILL_HEIGHT / 2,
          alignSelf: "flex-start",
          maxWidth: "100%",
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: 10,
          paddingRight: 14,
          borderWidth: 1,
          borderColor: color,
          backgroundColor: colors.raised,
          opacity,
        }}
      >
        <Icon name={look.icon} size={16} color={color} />
        <Text numberOfLines={1} style={{ color, fontWeight: "600", flexShrink: 0 }}>
          {look.title}
        </Text>
        {look.detail === "" ? null : (
          <Text numberOfLines={1} style={{ color, fontFamily: MONO, fontSize: 12, flexShrink: 1, textDecorationLine: look.struck ? "line-through" : "none" }}>
            {look.detail}
          </Text>
        )}
      </Pressable>
      {/* Mounted only while it is open, and keyed by the request as well as the opening: a different request is a different form, and closing discards everything this one held. */}
      {session === null ? null : (
        <RequestDialog
          key={`${item.data.requestId}:${session}`}
          requestId={item.data.requestId}
          session={session}
          onClose={() => setSession(null)}
          theme={theme}
          host={host}
          layout={layout}
        />
      )}
    </>
  );
}
