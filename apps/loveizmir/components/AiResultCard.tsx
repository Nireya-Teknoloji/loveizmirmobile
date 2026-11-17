import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import type { LoveIzmirCard } from "@/lib/loveizmirApi";

/** Sunucudaki aiCards.ts AI_CARD_IMAGE_KEYS ile aynı adlar (web ile aynı görseller). */
const CARD_IMAGES: Record<string, number> = {
  "izmir-kordon": require("@/assets/images/izmir-kordon.png"),
  konak: require("@/assets/images/konak.png"),
  "izmir-gastronomy": require("@/assets/images/izmir-gastronomy.png"),
  "cesme-alacati": require("@/assets/images/cesme-alacati.png"),
  "urla-marina": require("@/assets/images/urla-marina.png"),
  sirince: require("@/assets/images/sirince.png"),
  foca: require("@/assets/images/foca.png"),
  karaburun: require("@/assets/images/karaburun.png"),
  ephesus: require("@/assets/images/ephesus.png"),
  yacht: require("@/assets/images/yacht.png"),
  "stone-house": require("@/assets/images/stone-house.png"),
  art: require("@/assets/images/art.png"),
  airport: require("@/assets/images/airport.png"),
  asansor: require("@/assets/images/asansor.png"),
};

type Props = {
  card: LoveIzmirCard;
  onAction: (card: LoveIzmirCard) => void;
  onAsk: (card: LoveIzmirCard) => void;
};

export function AiResultCard({ card, onAction, onAsk }: Props) {
  const colors = useColors();
  const image = CARD_IMAGES[card.imageKey] ?? CARD_IMAGES["izmir-kordon"];
  const isMap = card.action.type === "OPEN_MAP";
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Pressable
        onPress={() => onAction(card)}
        accessibilityRole="button"
        accessibilityLabel={`${card.title} — ${card.action.label}`}
      >
        <View style={styles.media}>
          <Image source={image} style={StyleSheet.absoluteFill} contentFit="cover" />
          <LinearGradient
            colors={["transparent", "rgba(0,0,0,0.6)"]}
            style={StyleSheet.absoluteFill}
          />
          {card.district ? (
            <View style={styles.badge}>
              <Feather name="map-pin" size={11} color={colors.primary} />
              <Text style={styles.badgeText} numberOfLines={1}>
                {card.district}
              </Text>
            </View>
          ) : null}
          <Text style={styles.title} numberOfLines={2}>
            {card.title}
          </Text>
        </View>
        <Text
          style={[styles.summary, { color: colors.mutedForeground }]}
          numberOfLines={2}
        >
          {card.summary}
        </Text>
      </Pressable>
      <View style={styles.row}>
        <Pressable
          onPress={() => onAction(card)}
          style={[styles.primaryBtn, { backgroundColor: colors.aegeanDeep }]}
          accessibilityRole="button"
        >
          <Feather name={isMap ? "map-pin" : "arrow-up-right"} size={13} color="#fff" />
          <Text style={styles.primaryText}>{card.action.label}</Text>
        </Pressable>
        <Pressable
          onPress={() => onAsk(card)}
          style={[styles.secondaryBtn, { borderColor: colors.border }]}
          accessibilityRole="button"
        >
          <Feather name="message-circle" size={13} color={colors.foreground} />
          <Text style={[styles.secondaryText, { color: colors.foreground }]}>
            Daha fazla sor
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "100%",
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
  },
  media: { height: 120, justifyContent: "flex-end", overflow: "hidden" },
  badge: {
    position: "absolute",
    top: 10,
    left: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.92)",
    maxWidth: "70%",
  },
  badgeText: { fontFamily: "Inter_600SemiBold", fontSize: 11, color: "#0f172a" },
  title: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    lineHeight: 20,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  summary: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  row: { flexDirection: "row", gap: 8, padding: 12, paddingTop: 10 },
  primaryBtn: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
  },
  primaryText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 12 },
  secondaryBtn: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  secondaryText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
});
