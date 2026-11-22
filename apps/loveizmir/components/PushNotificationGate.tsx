// Girişten sonra bildirim izni ön açıklaması + bildirime dokununca rota.
// Girişsiz kullanıcıya hiçbir şey sorulmaz. Yalnız iOS/Android'de çizilir.
import * as Notifications from "expo-notifications";
import { useRootNavigationState, useRouter, type Href } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { HeartLogo } from "@/components/HeartLogo";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/lib/auth";
import {
  capturePushSession,
  flushPendingPushDeletes,
  isPushSessionAlive,
  onPushLogoutStart,
  type PushSession,
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

  // Kaydı yürüyen kullanıcı (aynı kullanıcı için ikinci deneme başlamasın).
  const runningFor = useRef<string | null>(null);
  const visibleRef = useRef(false);
  visibleRef.current = visible;
  // Ön sorunun açıldığı oturum; "İzin ver" yalnız bu oturum adına kaydeder.
  const promptSession = useRef<PushSession | null>(null);

  // İzin varsa sessizce kaydol, yoksa uygunsa sor. "Kontrol edildi" yalnız
  // sunucu kaydı başarılı olunca işaretlenir; olmazsa uygulama öne gelince
  // (ayarlardan izin açılınca dahil) yeniden denenir.
  const syncPush = useCallback(async (userId: string) => {
    if (checkedFor.current === userId || runningFor.current === userId) return;
    if (visibleRef.current) return;
    if (!isPushSessionAlive(capturePushSession(userId))) return; // çıkış sürüyor
    runningFor.current = userId;
    // Oturum akışın en başında yakalanır; her await sonrası denetlenir.
    const session = capturePushSession(userId);
    try {
      const stale = () =>
        userIdRef.current !== userId || !isPushSessionAlive(session);
      if (stale()) return;
      // Önceki çıkışta sunucudan silinemeyen kayıt varsa önce onu sil.
      await flushPendingPushDeletes();
      if (stale()) return;
      const { state } = await getPushPermission();
      if (stale()) return;
      if (state === "granted") {
        const ok = await registerPushDevice(session);
        if (ok && !stale()) checkedFor.current = userId;
        return;
      }
      const show = await shouldShowPushPrePrompt();
      // Beklerken çıkış yapıldıysa ya da oturum değiştiyse gösterme.
      if (show && !stale()) {
        promptSession.current = session;
        setVisible(true);
      }
    } finally {
      if (runningFor.current === userId) runningFor.current = null;
    }
  }, []);

  // Çıkış BAŞLADIĞI an açık ön soru kapanır (oturum silinmesini beklemeden).
  useEffect(
    () =>
      onPushLogoutStart(() => {
        promptSession.current = null;
        setVisible(false);
      }),
    [],
  );

  // Oturum açılınca / değişince.
  useEffect(() => {
    if (!user?.id) {
      // Çıkış: açık ön açıklama kapanır.
      checkedFor.current = null;
      setVisible(false);
      return;
    }
    if (isLoading) return;
    void syncPush(user.id);
  }, [user?.id, isLoading, syncPush]);

  // Uygulama öne gelince kayıt henüz başarılı değilse yeniden dene.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      const userId = userIdRef.current;
      if (next === "active" && userId) void syncPush(userId);
    });
    return () => sub.remove();
  }, [syncPush]);

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
    const session = promptSession.current;
    promptSession.current = null;
    if (!session || userIdRef.current !== session.userId) return;
    if (!isPushSessionAlive(session)) return;
    const ok = await requestPushPermissionAndRegister(session);
    if (ok && userIdRef.current === session.userId) {
      checkedFor.current = session.userId;
    }
  };

  const onLater = async () => {
    setVisible(false);
    promptSession.current = null;
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
