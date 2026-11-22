// Girişten sonra bildirim izni ön açıklaması + bildirime dokununca rota.
// Girişsiz kullanıcıya hiçbir şey sorulmaz. Yalnız iOS/Android'de çizilir.
import * as Notifications from "expo-notifications";
import { useRootNavigationState, useRouter, type Href } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { HeartLogo } from "@/components/HeartLogo";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/lib/auth";
import {
  flushPendingPushDeletes,
  getPushPermission,
  internalRouteFromNotification,
  registerPushDevice,
  requestPushPermissionAndRegister,
  shouldShowPushPrePrompt,
  snoozePushPrompt,
} from "@/lib/pushNotifications";

export function PushNotificationGate() {
  const colors = useColors();
  const router = useRouter();
  const navState = useRootNavigationState();
  const { user, isLoading } = useAuth();
  const [visible, setVisible] = useState(false);
  const checkedFor = useRef<string | null>(null);
  // Güncel oturum; await sonrası sonucun eski oturuma yazılmaması için.
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;
  const handledResponse = useRef<string | null>(null);
  const lastResponse = Notifications.useLastNotificationResponse();

  // Oturum açılınca: izin zaten varsa sessizce kaydol, yoksa uygun ise sor.
  useEffect(() => {
    if (isLoading || !user?.id) {
      if (!user?.id) checkedFor.current = null;
      return;
    }
    if (checkedFor.current === user.id) return;
    checkedFor.current = user.id;
    const userId = user.id;
    let cancelled = false;
    (async () => {
      // Önceki çıkışta sunucudan silinemeyen kayıt varsa önce onu sil.
      await flushPendingPushDeletes();
      const { state } = await getPushPermission();
      if (state === "granted") {
        await registerPushDevice(userId);
        return;
      }
      if (!cancelled && (await shouldShowPushPrePrompt())) setVisible(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isLoading]);

  // Bildirime dokunma (uygulama kapalıyken açılış dahil).
  useEffect(() => {
    if (!lastResponse || isLoading || !navState?.key) return;
    if (
      lastResponse.actionIdentifier !==
      Notifications.DEFAULT_ACTION_IDENTIFIER
    )
      return;
    const id = lastResponse.notification.request.identifier;
    if (handledResponse.current === id) return;
    handledResponse.current = id;
    const route = internalRouteFromNotification(lastResponse.notification);
    if (!route) return;
    const t = setTimeout(() => {
      try {
        router.push(route as Href);
      } catch (err) {
        console.warn("[bildirim] rota açılamadı", route, err);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [lastResponse, isLoading, navState?.key, router]);

  const onAllow = async () => {
    setVisible(false);
    const userId = userIdRef.current;
    if (!userId) return;
    await requestPushPermissionAndRegister(userId);
  };

  const onLater = async () => {
    setVisible(false);
    await snoozePushPrompt();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onLater}
    >
      <View style={styles.backdrop}>
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
          accessibilityViewIsModal
        >
          <View
            style={[styles.iconWrap, { backgroundColor: colors.secondary }]}
          >
            <HeartLogo size={30} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            Haber verelim mi?
          </Text>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>
            Talebine işletme cevap verince sana hemen haber verelim.
          </Text>
          <Pressable
            onPress={onAllow}
            style={[styles.primaryBtn, { backgroundColor: colors.accent }]}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>İzin ver</Text>
          </Pressable>
          <Pressable
            onPress={onLater}
            style={styles.secondaryBtn}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text
              style={[styles.secondaryBtnText, { color: colors.mutedForeground }]}
            >
              Şimdi değil
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(10, 22, 38, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 20,
    borderWidth: 1,
    padding: 24,
    alignItems: "center",
    gap: 10,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontFamily: "Poppins_700Bold",
    fontSize: 19,
    textAlign: "center",
  },
  body: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  primaryBtn: {
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    borderRadius: 99,
    marginTop: 8,
  },
  primaryBtnText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  secondaryBtn: {
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  secondaryBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
});
