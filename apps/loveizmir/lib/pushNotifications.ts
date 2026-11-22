// Anlık bildirim: izin, native push token'ı (şimdilik yalnız iOS APNs), cihaz
// kaydı ve bildirimden rota. Expo push servisi kullanılmaz (EAS projectId yok).
// Sunucu sözleşmesi: POST /api/me/push-devices { token, platform, provider },
// DELETE /api/me/push-devices { token }.
// Hiçbir hata kullanıcıya teknik metin olarak çıkmaz; yalnız log.
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { apiFetch, getAuthToken } from "./apiClient";
import { getString, removeKey, setString } from "./storage";

const SNOOZE_KEY = "push_prompt_snooze_until";
const OS_ASKED_KEY = "push_os_prompt_asked";
const TOKEN_KEY = "push_registered_token";
// Çıkışta sunucudan silinemeyen token'lar; sonraki açılış/girişte önce silinir.
const PENDING_DELETE_KEY = "push_pending_delete_tokens";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const DELETE_TIMEOUT_MS = 5000;
const LOG = "[bildirim]";

/**
 * Anlık bildirim bu platformda açık mı? Tek kontrol noktası.
 * Android: Firebase (google-services.json) ve sunucu FCM gönderimi yok; token
 * alma, kayıt ve izin ön açıklaması kapalı. FCM gelince buraya "android" eklenir.
 */
export function pushSupported(): boolean {
  return Platform.OS === "ios";
}

if (Platform.OS === "ios" || Platform.OS === "android") {
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
  if (!pushSupported()) return { state: "denied", canAskAgain: false };
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
  if (!pushSupported() || !Device.isDevice) return false;
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

/**
 * Oturum kuşağı: her çıkışta artar. Eski oturumda başlamış bir kaydın sonucu
 * yeni oturuma yazılmaz; çıkış başladıktan sonra biten POST hemen geri silinir.
 */
let sessionGen = 0;
let inflight: { userId: string; promise: Promise<boolean> } | null = null;
const POST_TIMEOUT_MS = 10000;
const LOGOUT_WAIT_MS = 10000;

type Registration = { token: string; userId: string | null };

async function readRegistration(): Promise<Registration | null> {
  const raw = await getString(TOKEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string" && parsed.token) {
      return {
        token: parsed.token,
        userId: typeof parsed.userId === "string" ? parsed.userId : null,
      };
    }
  } catch {
    // Eski biçim: düz token.
  }
  return { token: raw, userId: null };
}

/** Bu kullanıcı için sunucuda başarılı bir cihaz kaydı var mı? */
export async function hasPushRegistration(userId: string): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await readRegistration();
  return !!reg && reg.userId === userId;
}

/**
 * Android 13+: izin penceresi ancak en az bir bildirim kanalı varken çıkar;
 * kanal izin isteğinden ÖNCE oluşturulur. iOS'ta etkisiz.
 */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Bildirimler",
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: "#ff6b6b",
    });
  } catch (err) {
    console.warn(LOG, "bildirim kanalı oluşturulamadı", err);
  }
}

/** Sistem izin penceresini açar; izin verilirse cihazı kaydeder. */
export async function requestPushPermissionAndRegister(
  userId: string,
): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    await ensureAndroidChannel();
    await setString(OS_ASKED_KEY, "1");
    const res = await Notifications.requestPermissionsAsync();
    if (!res.granted) return false;
    return await registerPushDevice(userId);
  } catch (err) {
    console.warn(LOG, "izin istenemedi", err);
    return false;
  }
}

/**
 * İzin verilmişse token alır ve API'ye bu kullanıcı adına kaydeder. Aynı anda
 * tek kayıt yürür; çıkış onu bekler. Yalnız sunucu kaydı başarılıysa true.
 * Hata fırlatmaz.
 */
export function registerPushDevice(userId: string): Promise<boolean> {
  if (!pushSupported()) return Promise.resolve(false);
  if (inflight && inflight.userId === userId) return inflight.promise;
  const gen = sessionGen;
  const promise: Promise<boolean> = doRegister(userId, gen).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { userId, promise };
  return promise;
}

async function doRegister(userId: string, gen: number): Promise<boolean> {
  if (!Device.isDevice) {
    console.info(LOG, "simülatör/emülatör: token adımı atlandı");
    return false;
  }
  try {
    const { state } = await getPushPermission();
    if (state !== "granted") return false;

    await ensureAndroidChannel();

    // iOS: APNs cihaz token'ı (hex).
    let token: string;
    try {
      const native = await Notifications.getDevicePushTokenAsync();
      token = String(native.data ?? "");
    } catch (err) {
      console.warn(LOG, "native push token alınamadı, kayıt atlandı", err);
      return false;
    }
    if (!token) {
      console.warn(LOG, "native push token boş, kayıt atlandı");
      return false;
    }
    if (gen !== sessionGen) return false;

    // Başka bir oturumdan kalmış yerel kayıt varsa bekleyen silmeye al.
    const previous = await readRegistration();
    if (previous && previous.userId !== userId) {
      await addPendingDelete(previous.token);
      await removeKey(TOKEN_KEY);
    }
    // Önceki çıkıştan kalan silmeler yeni kayıttan önce.
    await flushPendingPushDeletes();
    if (gen !== sessionGen) return false;

    const provider = Platform.OS === "ios" ? "apns" : "fcm";
    const res = await apiFetchWithTimeout(
      "/api/me/push-devices",
      {
        method: "POST",
        body: JSON.stringify({ token, platform: Platform.OS, provider }),
      },
      POST_TIMEOUT_MS,
    );
    if (!res.ok) {
      console.warn(LOG, "cihaz kaydı başarısız", res.status);
      return false;
    }
    if (gen !== sessionGen) {
      // Kayıt sürerken çıkış başladı: bu kaydı eski oturum geçerliyken geri al.
      if (!(await deleteRemoteToken(token))) await addPendingDelete(token);
      return false;
    }
    await setString(TOKEN_KEY, JSON.stringify({ token, userId }));
    // Aynı token bekleyen silmede kaldıysa artık yeni hesaba ait: silinmesin.
    const pending = await readPendingDeletes();
    if (pending.includes(token)) {
      await writePendingDeletes(pending.filter((t) => t !== token));
    }
    return true;
  } catch (err) {
    console.warn(LOG, "cihaz kaydı hatası", err);
    return false;
  }
}

async function apiFetchWithTimeout(
  path: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await apiFetch(path, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Token'ı sunucudan siler: kısa zaman aşımı, bir kez yeniden dener. */
async function deleteRemoteToken(token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await apiFetchWithTimeout(
        "/api/me/push-devices",
        { method: "DELETE", body: JSON.stringify({ token }) },
        DELETE_TIMEOUT_MS,
      );
      // 404: sunucuda bu oturuma ait kayıt yok, silinecek bir şey kalmadı.
      if (res.ok || res.status === 404) return true;
      console.warn(LOG, "cihaz kaydı silinemedi", res.status);
    } catch (err) {
      console.warn(LOG, "cihaz kaydı silme hatası", err);
    }
  }
  return false;
}

async function readPendingDeletes(): Promise<string[]> {
  try {
    const raw = await getString(PENDING_DELETE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((t): t is string => typeof t === "string" && !!t)
      : [];
  } catch {
    return [];
  }
}

async function writePendingDeletes(list: string[]): Promise<void> {
  if (list.length === 0) await removeKey(PENDING_DELETE_KEY);
  else await setString(PENDING_DELETE_KEY, JSON.stringify(list));
}

async function addPendingDelete(token: string): Promise<void> {
  const list = await readPendingDeletes();
  if (!list.includes(token)) list.push(token);
  await writePendingDeletes(list);
}

let flushing: Promise<void> | null = null;

/**
 * Önceki çıkışta silinemeyen token'ları siler. Geçerli oturum yoksa bekler.
 * Yeni kayıttan (POST) önce çağrılır. Hata fırlatmaz.
 */
export function flushPendingPushDeletes(): Promise<void> {
  if (!pushSupported()) return Promise.resolve();
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      const list = await readPendingDeletes();
      if (list.length === 0) return;
      if (!(await getAuthToken())) return;
      const remaining: string[] = [];
      for (const token of list) {
        if (!(await deleteRemoteToken(token))) remaining.push(token);
      }
      // Bu arada eklenenler korunur.
      const latest = await readPendingDeletes();
      await writePendingDeletes(
        latest.filter((t) => !list.includes(t) || remaining.includes(t)),
      );
    } catch (err) {
      console.warn(LOG, "bekleyen silmeler işlenemedi", err);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/**
 * Çıkışta, oturum token'ı silinmeden ÖNCE çağrılır. Önce sunucudan siler;
 * başarılıysa yerel kaydı kaldırır, değilse token'ı bekleyen silmeye alır.
 * Hata fırlatmaz.
 */
export async function unregisterPushDevice(): Promise<void> {
  if (!pushSupported()) return;
  // Yeni kayıt başlamasın; süren kayıt bitsin (en çok LOGOUT_WAIT_MS).
  sessionGen += 1;
  const running = inflight?.promise;
  if (running) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running.catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(resolve, LOGOUT_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  try {
    const reg = await readRegistration();
    if (!reg) return;
    const token = reg.token;
    if (!(await deleteRemoteToken(token))) await addPendingDelete(token);
    await removeKey(TOKEN_KEY);
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

/**
 * Dokunulan bildirimden iç rota. Native APNs yükünde url üst düzey alanda
 * gelir: content.data yanında iOS'ta trigger.payload, Android'de
 * trigger.remoteMessage.data da denetlenir.
 */
export function internalRouteFromNotification(
  notification: Notifications.Notification,
): string | null {
  const { content, trigger } = notification.request;
  const fromData = internalRouteFromData(content.data);
  if (fromData) return fromData;
  const t = trigger as {
    payload?: Record<string, unknown>;
    remoteMessage?: { data?: Record<string, unknown> };
  } | null;
  return (
    internalRouteFromData(t?.payload) ??
    internalRouteFromData(t?.remoteMessage?.data) ??
    null
  );
}
