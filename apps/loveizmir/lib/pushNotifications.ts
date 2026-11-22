// Anlık bildirim: izin, Expo push token'ı, cihaz kaydı ve bildirimden rota.
// Sunucu sözleşmesi: POST/DELETE /api/me/push-devices { token, platform? }.
// Hiçbir hata kullanıcıya teknik metin olarak çıkmaz; yalnız log.
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { apiFetch } from "./apiClient";
import { getString, removeKey, setString } from "./storage";

const SNOOZE_KEY = "push_prompt_snooze_until";
const OS_ASKED_KEY = "push_os_prompt_asked";
const TOKEN_KEY = "push_registered_token";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const LOG = "[bildirim]";

export const pushSupported = Platform.OS === "ios" || Platform.OS === "android";

if (pushSupported) {
  // Uygulama ön plandayken de banner görünsün.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export type PushPermissionState = "granted" | "denied" | "undetermined";

export async function getPushPermission(): Promise<{
  state: PushPermissionState;
  canAskAgain: boolean;
}> {
  if (!pushSupported) return { state: "denied", canAskAgain: false };
  try {
    const res = await Notifications.getPermissionsAsync();
    const granted =
      res.granted ||
      res.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    return {
      state: granted ? "granted" : (res.status as PushPermissionState),
      canAskAgain: res.canAskAgain,
    };
  } catch (err) {
    console.warn(LOG, "izin durumu okunamadı", err);
    return { state: "denied", canAskAgain: false };
  }
}

/** Girişli kullanıcıya ön açıklama gösterilmeli mi? */
export async function shouldShowPushPrePrompt(): Promise<boolean> {
  if (!pushSupported || !Device.isDevice) return false;
  const { state, canAskAgain } = await getPushPermission();
  if (state === "granted" || !canAskAgain) return false;
  if (await getString(OS_ASKED_KEY)) return false;
  const until = Number((await getString(SNOOZE_KEY)) ?? 0);
  return !(until && Date.now() < until);
}

/** "Şimdi değil": 7 gün tekrar sorma. */
export async function snoozePushPrompt(): Promise<void> {
  await setString(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
}

/** Sistem izin penceresini açar; izin verilirse cihazı kaydeder. */
export async function requestPushPermissionAndRegister(): Promise<boolean> {
  if (!pushSupported) return false;
  try {
    await setString(OS_ASKED_KEY, "1");
    const res = await Notifications.requestPermissionsAsync();
    if (!res.granted) return false;
    await registerPushDevice();
    return true;
  } catch (err) {
    console.warn(LOG, "izin istenemedi", err);
    return false;
  }
}

function resolveProjectId(): string | null {
  const fromExtra = (
    Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  )?.eas?.projectId;
  const fromEas = (Constants as { easConfig?: { projectId?: string } })
    .easConfig?.projectId;
  return fromExtra || fromEas || null;
}

/** İzin verilmişse token alır ve API'ye kaydeder. Hata fırlatmaz. */
export async function registerPushDevice(): Promise<string | null> {
  if (!pushSupported) return null;
  if (!Device.isDevice) {
    console.info(LOG, "simülatör/emülatör: token adımı atlandı");
    return null;
  }
  try {
    const { state } = await getPushPermission();
    if (state !== "granted") return null;

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Bildirimler",
        importance: Notifications.AndroidImportance.DEFAULT,
        lightColor: "#ff6b6b",
      });
    }

    const projectId = resolveProjectId();
    if (!projectId) {
      console.warn(LOG, "EAS projectId yok: push token alınmadı");
      return null;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId,
    });
    const res = await apiFetch("/api/me/push-devices", {
      method: "POST",
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
    if (!res.ok) {
      console.warn(LOG, "cihaz kaydı başarısız", res.status);
      return null;
    }
    await setString(TOKEN_KEY, token);
    return token;
  } catch (err) {
    console.warn(LOG, "cihaz kaydı hatası", err);
    return null;
  }
}

/** Çıkışta çağrılır (oturum token'ı silinmeden önce). Hata fırlatmaz. */
export async function unregisterPushDevice(): Promise<void> {
  if (!pushSupported) return;
  try {
    const token = await getString(TOKEN_KEY);
    if (!token) return;
    await removeKey(TOKEN_KEY);
    const res = await apiFetch("/api/me/push-devices", {
      method: "DELETE",
      body: JSON.stringify({ token }),
    });
    if (!res.ok) console.warn(LOG, "cihaz kaydı silinemedi", res.status);
  } catch (err) {
    console.warn(LOG, "cihaz kaydı silme hatası", err);
  }
}

/** Bildirim verisindeki url yalnız "/" ile başlayan iç rotaysa döner. */
export function internalRouteFromData(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const url = (data as { url?: unknown }).url;
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  if (trimmed.includes("\\") || /\s/.test(trimmed)) return null;
  return trimmed;
}
