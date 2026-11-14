/**
 * Nireya imzası (NKOS-UI-116): açılış ekranının altında "powered by" + yatay Nireya logosu.
 * Görseller: assets/nireya-imza/ (Nireya beyin deposu › araclar/nireya-imza/uret.mjs ile üretilir).
 *
 * iOS: SplashScreen.storyboard'a ikinci görsel; frame + autoresizingMask ile yatay ortada, alt kenarı
 *      393 × 852 tuvalde güvenli alanın (34 pt) 32 pt üstünde; kısıt kullanılmaz (expo-splash-screen uygulamaz).
 * Android 12+: Theme.App.SplashScreen › android:windowSplashScreenBrandingImage.
 * Yerel varlık: OTA ile gitmez, yeni derleme gerekir.
 */
const fs = require('fs');
const path = require('path');
const {
  withDangerousMod,
  withAndroidStyles,
  withMod,
} = require('expo/config-plugins');

const KAYNAK = 'assets/nireya-imza';
const IOS_GORSEL = 'NireyaImza';
const IOS_ID = 'NIREYA-Imza';
const GUVENLI_ALAN_BOSLUK = 32;
const ANDROID_GORSEL = 'nireya_imza';

function iosGorselleri(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const { projectRoot, platformProjectRoot, projectName } = cfg.modRequest;
      const hedef = path.join(platformProjectRoot, projectName, 'Images.xcassets', `${IOS_GORSEL}.imageset`);
      fs.mkdirSync(hedef, { recursive: true });
      const images = [];
      for (const [ek, olcek] of [['', '1x'], ['@2x', '2x'], ['@3x', '3x']]) {
        const ad = `${IOS_GORSEL}${ek}.png`;
        fs.copyFileSync(path.join(projectRoot, KAYNAK, 'ios', ad), path.join(hedef, ad));
        images.push({ idiom: 'universal', filename: ad, scale: olcek });
      }
      fs.writeFileSync(
        path.join(hedef, 'Contents.json'),
        JSON.stringify({ images, info: { version: 1, author: 'expo' } }, null, 2)
      );
      return cfg;
    },
  ]);
}

function iosStoryboard(config) {
  return withMod(config, {
    platform: 'ios',
    mod: 'splashScreenStoryboard',
    action: (cfg) => {
      const xml = cfg.modResults;
      const view = xml.document.scenes[0].scene[0].objects[0].viewController[0].view[0];
      const guvenliAlan = view.viewLayoutGuide?.find((g) => g.$.key === 'safeArea')?.$.id;
      if (!guvenliAlan) throw new Error('withNireyaImzasi: SplashScreen.storyboard içinde safeArea yok');

      const kaynak = path.join(cfg.modRequest.projectRoot, KAYNAK, 'ios', `${IOS_GORSEL}.png`);
      const png = fs.readFileSync(kaynak);
      const gen = png.readUInt32BE(16);
      const yuk = png.readUInt32BE(20);
      const ekranGen = Number(view.rect[0].$.width);
      const ekranYuk = Number(view.rect[0].$.height);

      // expo-splash-screen açılış görünümünü (SplashScreenManager.showSplashScreen) storyboard'dan alıp
      // yalnız frame ile ekrana oturtur; Auto Layout kısıtları uygulanmaz (14 Kas Loveİzmir testinde
      // kısıtlı imza 0,0'da kaldı). Bu yüzden konum frame + autoresizingMask ile verilir: frame
      // 393 × 852 tuvalde alt-ortada, kap büyüyünce yatayda ortada kalır, alta yapışık iner.
      view.subviews[0].imageView = (view.subviews[0].imageView || []).filter((v) => v.$.id !== IOS_ID);
      view.subviews[0].imageView.push({
        $: {
          id: IOS_ID,
          userLabel: IOS_GORSEL,
          image: IOS_GORSEL,
          contentMode: 'scaleAspectFit',
          clipsSubviews: true,
          userInteractionEnabled: false,
          translatesAutoresizingMaskIntoConstraints: true,
        },
        rect: [{ $: { key: 'frame', x: (ekranGen - gen) / 2, y: ekranYuk - 34 - GUVENLI_ALAN_BOSLUK - yuk, width: gen, height: yuk } }],
        autoresizingMask: [{ $: { key: 'autoresizingMask', flexibleMinX: 'YES', flexibleMaxX: 'YES', flexibleMinY: 'YES' } }],
      });

      // Eski sürümün kısıtları kalmışsa temizlenir (autoresizing ile çakışır).
      if (view.constraints?.[0]?.constraint) {
        view.constraints[0].constraint = view.constraints[0].constraint.filter((c) => c.$.firstItem !== IOS_ID && c.$.secondItem !== IOS_ID);
      }

      const kaynaklar = xml.document.resources[0];
      kaynaklar.image = (kaynaklar.image || []).filter((i) => i.$.name !== IOS_GORSEL);
      kaynaklar.image.push({ $: { name: IOS_GORSEL, width: gen, height: yuk } });
      return cfg;
    },
  });
}

function androidGorselleri(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const { projectRoot, platformProjectRoot } = cfg.modRequest;
      const kaynak = path.join(projectRoot, KAYNAK, 'android');
      for (const klasor of fs.readdirSync(kaynak)) {
        const hedef = path.join(platformProjectRoot, 'app/src/main/res', klasor);
        fs.mkdirSync(hedef, { recursive: true });
        fs.copyFileSync(path.join(kaynak, klasor, `${ANDROID_GORSEL}.png`), path.join(hedef, `${ANDROID_GORSEL}.png`));
      }
      return cfg;
    },
  ]);
}

function androidStil(config) {
  return withAndroidStyles(config, (cfg) => {
    const res = cfg.modResults.resources;
    res.$ = { ...(res.$ || {}), 'xmlns:tools': 'http://schemas.android.com/tools' };
    const stil = (res.style || []).find((s) => s.$.name === 'Theme.App.SplashScreen');
    if (!stil) throw new Error('withNireyaImzasi: Theme.App.SplashScreen stili yok (splash ayarı eksik)');
    stil.item = (stil.item || []).filter((i) => i.$.name !== 'android:windowSplashScreenBrandingImage');
    stil.item.push({
      $: { name: 'android:windowSplashScreenBrandingImage', 'tools:targetApi': '31' },
      _: `@drawable/${ANDROID_GORSEL}`,
    });
    return cfg;
  });
}

module.exports = function withNireyaImzasi(config) {
  config = iosGorselleri(config);
  config = iosStoryboard(config);
  config = androidGorselleri(config);
  config = androidStil(config);
  return config;
};
