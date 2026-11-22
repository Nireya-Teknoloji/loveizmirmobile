// Anlık bildirim: izin, native push token'ı (şimdilik yalnız iOS APNs), cihaz
// kaydı ve bildirimden rota. Expo push servisi kullanılmaz (EAS projectId yok).
// Sunucu sözleşmesi: POST /api/me/push-devices { token, platform, provider, seq },
// DELETE /api/me/push-devices { token, seq }. seq cihaz başına monoton artar;
// sunucu daha düşük seq'li geç gelen isteği yok sayar (eski POST: 409
// STALE_SEQ, DELETE her zaman 204). Yeniden deneme aynı işlemin seq'iyle olur.
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
const SEQ_KEY = "push_last_seq";
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
// Çıkış başladığı andan oturum silinene kadar true: yeni kayıt başlamaz.
let loggingOut = false;
let inflight: {
  userId: string;
  gen: number;
  promise: Promise<boolean>;
} | null = null;

/**
 * Akışın en başında alınır (ön soru / izin isteğinden önce) ve tüm adımlara
 * geçirilir. Çıkış başlarsa ya da oturum biterse geçersizleşir.
 */
export type PushSession = { userId: string; gen: number };

export function capturePushSession(userId: string): PushSession {
  return { userId, gen: sessionGen };
}

/** Oturum hâlâ aynı ve çıkış sürmüyor mu? */
export function isPushSessionAlive(session: PushSession): boolean {
  return !loggingOut && session.gen === sessionGen;
}

const logoutListeners = new Set<() => void>();

/** Çıkış başladığı an (ilk await'ten önce) çağrılır; ör. açık ön soru kapanır. */
export function onPushLogoutStart(listener: () => void): () => void {
  logoutListeners.add(listener);
  return () => {
    logoutListeners.delete(listener);
  };
}

/** Oturum çıkış dışı bir yolla bittiğinde (ör. sunucu oturumu reddetti). */
export function invalidatePushSession(): void {
  sessionGen += 1;
}
const POST_TIMEOUT_MS = 10000;
const LOGOUT_WAIT_MS = 10000;

/** seq: bu yerel kaydı yazan POST'un seq'i (eski biçimde yok). */
type Registration = { token: string; userId: string | null; seq: number | null };

let tokenLock: Promise<unknown> = Promise.resolve();

/**
 * Yerel kaydın (TOKEN_KEY) her oku-karşılaştır-yaz/sil işlemi bu kilitle sırayla yürür;
 * eski bir oturumun gecikmiş geri alması yeni oturumun yazdığı kaydı ezemez.
 */
function withTokenLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tokenLock.then(fn);
  tokenLock = run.catch(() => undefined);
  return run;
}

/** Yerel kayıt yalnız verilen kayıtla (token + kullanıcı + seq) birebir aynıysa silinir. */
function removeRegistrationIf(expected: Registration): Promise<void> {
  return withTokenLock(async () => {
    const reg = await readRegistration();
    if (
      reg &&
      reg.token === expected.token &&
      reg.userId === expected.userId &&
      reg.seq === expected.seq
    ) {
      await removeKey(TOKEN_KEY);
    }
  });
}

async function readRegistration(): Promise<Registration | null> {
  const raw = await getString(TOKEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string" && parsed.token) {
      return {
        token: parsed.token,
        userId: typeof parsed.userId === "string" ? parsed.userId : null,
        seq: typeof parsed.seq === "number" ? parsed.seq : null,
      };
    }
  } catch {
    // Eski biçim: düz token.
  }
  return { token: raw, userId: null, seq: null };
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
  session: PushSession,
): Promise<boolean> {
  if (!pushSupported() || !isPushSessionAlive(session)) return false;
  try {
    await ensureAndroidChannel();
    await setString(OS_ASKED_KEY, "1");
    const res = await Notifications.requestPermissionsAsync();
    // İzin penceresi açıkken çıkış yapıldıysa kayıt yok.
    if (!res.granted || !isPushSessionAlive(session)) return false;
    return await registerPushDevice(session);
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
export function registerPushDevice(session: PushSession): Promise<boolean> {
  if (!pushSupported() || !isPushSessionAlive(session)) {
    return Promise.resolve(false);
  }
  const { userId, gen } = session;
  if (inflight && inflight.userId === userId && inflight.gen === gen) {
    return inflight.promise;
  }
  const promise: Promise<boolean> = doRegister(session).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { userId, gen, promise };
  return promise;
}

async function doRegister(session: PushSession): Promise<boolean> {
  const { userId } = session;
  const alive = () => isPushSessionAlive(session);
  if (!Device.isDevice) {
    console.info(LOG, "simülatör/emülatör: token adımı atlandı");
    return false;
  }
  try {
    const { state } = await getPushPermission();
    if (state !== "granted" || !alive()) return false;

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
    if (!alive()) return false;

    // Başka bir oturumdan kalmış yerel kayıt varsa bekleyen silmeye al.
    // Başka bir hesaptan kalmış yerel kayıt: oku, silme seq'ini ayır ve kuyruğa al — hepsi
    // tek kilit içinde ve oturum geçerliyken. seq burada alındığı için bundan sonra açılacak
    // her oturumun kaydından küçüktür; gecikse de yeni kaydı silemez (sunucu yok sayar).
    const cleared = await withTokenLock(async () => {
      if (!alive()) return false;
      const previous = await readRegistration();
      if (previous && previous.userId !== userId) {
        const delSeq = await nextPushSeq();
        await addPendingDelete(previous.token, delSeq);
        await removeKey(TOKEN_KEY);
      }
      return true;
    });
    if (!cleared || !alive()) return false;
    // Önceki çıkıştan kalan silmeler yeni kayıttan önce.
    await flushPendingPushDeletes();
    if (!alive()) return false;

    const provider = Platform.OS === "ios" ? "apns" : "fcm";
    // Bu kaydın seq'i bekleyen silmelerinkinden büyüktür (onlar önce alındı).
    const seq = await nextPushSeq();
    // Bu kaydı geri alma (temizlik) seq'i ŞİMDİ, POST'tan hemen sonra ayrılır: POST'tan büyük,
    // ama bundan sonra başka bir hesabın yapacağı her kayıttan küçüktür. Eski POST geç dönse de
    // temizlik yeni hesabın kaydını iptal edemez (sunucu küçük seq'li DELETE'i yok sayar).
    const cleanupSeq = await nextPushSeq();
    if (!alive()) return false;
    let res: Response;
    try {
      res = await apiFetchWithTimeout(
        "/api/me/push-devices",
        {
          method: "POST",
          body: JSON.stringify({
            token,
            platform: Platform.OS,
            provider,
            seq,
          }),
        },
        POST_TIMEOUT_MS,
      );
    } catch (err) {
      // Yanıt yok (zaman aşımı/ağ): sunucu kaydetmiş olabilir. Belirsiz kayıt
      // bekleyen silmeye alınır; çıkışta ya da sonraki denemeden önce silinir,
      // sonraki başarılı kayıtta listeden çıkar.
      console.warn(LOG, "cihaz kaydı yanıtsız, belirsiz", err);
      await addPendingDelete(token, cleanupSeq);
      return false;
    }
    if (!res.ok) {
      // 409 STALE_SEQ: daha yeni bir işlem var; başarısız sayılır, uygulama
      // öne gelince yeni seq ile yeniden denenir.
      console.warn(LOG, "cihaz kaydı başarısız", res.status);
      // 5xx: sunucu kaydedip sonra hata vermiş olabilir.
      if (res.status >= 500) await addPendingDelete(token, cleanupSeq);
      return false;
    }
    if (!alive()) {
      // Kayıt sürerken çıkış başladı: bu kaydı ayrılmış temizlik seq'iyle geri al.
      await deleteOrQueue(token, cleanupSeq);
      return false;
    }
    try {
      // Kilit içinde ve yalnız oturum hâlâ geçerliyse yazılır; kayıt POST seq'ini taşır.
      const written = await withTokenLock(async () => {
        if (!alive()) return false;
        await setString(TOKEN_KEY, JSON.stringify({ token, userId, seq }));
        return true;
      });
      if (!written) {
        await deleteOrQueue(token, cleanupSeq);
        return false;
      }
    } catch (err) {
      // Sunucu kaydetti ama yerelde tutulamadı: çıkışta bulunamayacağı için hesaba bağlı
      // kalmasın; ayrılmış temizlik seq'iyle hemen geri alınır (olmazsa bekleyen silmeye).
      console.warn(LOG, "cihaz kaydı yerelde saklanamadı, geri alınıyor", err);
      await deleteOrQueue(token, cleanupSeq).catch(() => undefined);
      return false;
    }
    // Yerel yazım sürerken çıkış başlamış olabilir: çıkış (en çok 10 sn bekler) bu kaydı
    // bulamadan bitmiş olabilir. Oturum artık geçerli değilse kayıt burada geri alınır.
    if (!alive()) {
      await rollbackAfterSessionEnd({ token, userId, seq }, cleanupSeq);
      return false;
    }
    // Aynı token bekleyen silmede kaldıysa artık yeni hesaba ait: silinmesin. Yalnız bu
    // kayıttan ÖNCE ayrılmış silmeler düşer; daha sonra eklenen (seq > bu kayıt) korunur.
    await removePendingDelete(token, seq);
    if (!alive()) {
      await rollbackAfterSessionEnd({ token, userId, seq }, cleanupSeq);
      return false;
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
let seqChain: Promise<number> = Promise.resolve(0);

/**
 * Cihaz başına monoton sıra numarası: max(Date.now(), son+1). Kalıcı saklanır;
 * aynı anda çağrılsa da her çağrı farklı ve daha büyük değer alır.
 */
function nextPushSeq(): Promise<number> {
  const next = seqChain.then(async () => {
    const last = Number((await getString(SEQ_KEY)) ?? 0) || 0;
    const seq = Math.max(Date.now(), last + 1);
    await setString(SEQ_KEY, String(seq));
    return seq;
  });
  seqChain = next.catch(() => 0);
  return next;
}

/**
 * Token'ı sunucudan siler: kısa zaman aşımı, bir kez yeniden dener. Yeniden
 * deneme AYNI seq ile yapılır.
 */
async function deleteRemoteToken(token: string, seq: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await apiFetchWithTimeout(
        "/api/me/push-devices",
        { method: "DELETE", body: JSON.stringify({ token, seq }) },
        DELETE_TIMEOUT_MS,
      );
      // Sunucu DELETE'te her zaman 204 döner; 404 eski sunucu için "yok".
      if (res.ok || res.status === 404) return true;
      console.warn(LOG, "cihaz kaydı silinemedi", res.status);
    } catch (err) {
      console.warn(LOG, "cihaz kaydı silme hatası", err);
    }
  }
  return false;
}

/**
 * Oturum kayıt bittikten sonra kapandıysa: sunucu kaydı ayrılmış temizlik seq'iyle geri
 * alınır (olmazsa bekleyen silmeye); yerel kayıt yalnız hâlâ BU kaydı (token + kullanıcı +
 * POST seq'i) gösteriyorsa silinir. Aynı kullanıcı yeniden girip aynı token'ı daha büyük
 * seq'le kaydettiyse o kayda dokunulmaz.
 * Depolama tamamen yazılamıyorsa bekleyen silme de tutulamaz; bu durumda bir sonraki
 * girişte doRegister önceki kaydı başka hesaba ait görüp silmeye alır.
 */
async function rollbackAfterSessionEnd(
  registration: Registration,
  cleanupSeq: number,
): Promise<void> {
  try {
    await deleteOrQueue(registration.token, cleanupSeq);
  } catch (err) {
    console.warn(LOG, "çıkış sonrası kayıt geri alınamadı", err);
  }
  try {
    await removeRegistrationIf(registration);
  } catch (err) {
    console.warn(LOG, "yerel kayıt temizlenemedi", err);
  }
}

/** Verilen (yoksa yeni) seq ile siler; olmazsa aynı seq'le bekleyen silmeye alır. */
async function deleteOrQueue(token: string, reservedSeq?: number): Promise<void> {
  const seq = reservedSeq ?? (await nextPushSeq());
  if (!(await deleteRemoteToken(token, seq))) await addPendingDelete(token, seq);
}

type PendingDelete = { token: string; seq: number };

async function readPendingDeletes(): Promise<PendingDelete[]> {
  try {
    const raw = await getString(PENDING_DELETE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const out: PendingDelete[] = [];
    for (const item of list) {
      if (typeof item === "string" && item) {
        // Eski biçim (yalnız token): seq ilk denemede verilir.
        out.push({ token: item, seq: 0 });
      } else if (
        item &&
        typeof item.token === "string" &&
        item.token &&
        typeof item.seq === "number"
      ) {
        out.push({ token: item.token, seq: item.seq });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function writePendingDeletes(list: PendingDelete[]): Promise<void> {
  if (list.length === 0) await removeKey(PENDING_DELETE_KEY);
  else await setString(PENDING_DELETE_KEY, JSON.stringify(list));
}

let pendingLock: Promise<unknown> = Promise.resolve();

/**
 * Bekleyen silme listesinin her oku-değiştir-yaz işlemi bu kilitle sırayla yürür;
 * eşzamanlı ekleme/temizleme birbirinin yazdığını ezmez.
 */
function withPendingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = pendingLock.then(fn);
  pendingLock = run.catch(() => undefined);
  return run;
}

/**
 * seq verilmezse yeni seq alınır. Aynı token için listede daha büyük seq'li işlem
 * varsa o korunur (daha yeni işlem eskisiyle ezilmez).
 */
async function addPendingDelete(token: string, seq?: number): Promise<void> {
  const opSeq = seq ?? (await nextPushSeq());
  await withPendingLock(async () => {
    const list = await readPendingDeletes();
    const existing = list.find((p) => p.token === token);
    if (existing && existing.seq >= opSeq) return;
    await writePendingDeletes([
      ...list.filter((p) => p.token !== token),
      { token, seq: opSeq },
    ]);
  });
}

/** Yalnız seq'i belirtilenden küçük (daha eski) bekleyen silmeyi düşürür. */
async function removePendingDelete(token: string, beforeSeq: number): Promise<void> {
  await withPendingLock(async () => {
    const list = await readPendingDeletes();
    const next = list.filter((p) => !(p.token === token && p.seq < beforeSeq));
    if (next.length !== list.length) await writePendingDeletes(next);
  });
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
      const done: PendingDelete[] = [];
      for (const item of list) {
        // Kaydedilmiş seq ile yeniden dene (aynı işlem).
        const seq = item.seq > 0 ? item.seq : await nextPushSeq();
        if (await deleteRemoteToken(item.token, seq)) done.push(item);
        else if (seq !== item.seq) await addPendingDelete(item.token, seq);
      }
      // Yalnız 204 alınanlar temizlenir; bu arada eklenen/yenilenenler korunur.
      // Okuma ve yazma tek kilit içinde: arada eklenen kayıt kaybolmaz.
      await withPendingLock(async () => {
        const latest = await readPendingDeletes();
        const next = latest.filter(
          (p) => !done.some((d) => d.token === p.token && d.seq === p.seq),
        );
        if (next.length !== latest.length) await writePendingDeletes(next);
      });
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
  // Await'lerden önce: oturum geçersiz, yeni kayıt başlamasın; süren kayıt
  // bitsin (en çok LOGOUT_WAIT_MS). Bayrak endPushLogout() ile iner.
  sessionGen += 1;
  loggingOut = true;
  logoutListeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.warn(LOG, "çıkış dinleyicisi hatası", err);
    }
  });
  if (!pushSupported()) return;
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
    const reg = await withTokenLock(readRegistration);
    if (reg) {
      await deleteOrQueue(reg.token);
      await removeRegistrationIf(reg);
    }
    // Belirsiz/bekleyen kayıtlar da oturum hâlâ geçerliyken silinsin.
    await flushPendingPushDeletes();
  } catch (err) {
    console.warn(LOG, "cihaz kaydı silme hatası", err);
  }
}

/** Çıkış bitti (oturum token'ı silindi): yeni oturumda kayıt serbest. */
export function endPushLogout(): void {
  loggingOut = false;
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
