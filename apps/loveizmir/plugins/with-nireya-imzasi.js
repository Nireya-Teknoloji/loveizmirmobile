// Nireya imzası (NKOS-UI-116): açılış ekranının altında "powered by" + yatay Nireya logosu.
// Görseller assets/images/nireya-imza/ altında hazır üretilir (11 pt yazı, %60 opaklık, ® turuncu, 6 pt boşluk, 20 pt logo; araclar/nireya-imza/uret.mjs --zemin acik).
// iOS: SplashScreen.storyboard'a ikinci görsel; alt kenarı güvenli alanın 32 pt üstünde, yatayda ortada.
// Android 12+: Theme.App.SplashScreen › android:windowSplashScreenBrandingImage (200x80 dp tuval, imza altta).
// expo-splash-screen storyboard kısıtlarını yeniden yazdığı için iki taraf da "finalized" aşamasında, en sonda uygulanır.
const fs = require('fs');
const path = require('path');
const { withFinalizedMod } = require('expo/config-plugins');

const KAYNAK = 'assets/images/nireya-imza';
const IOS_AD = 'NireyaImza';
const IOS_ID = 'NIREYA-Imza';
const ALT_BOSLUK_PT = 32;

function iosImza(config) {
  return withFinalizedMod(config, [
    'ios',
    async (cfg) => {
      const { projectRoot, platformProjectRoot, projectName } = cfg.modRequest;
      const kaynak = path.join(projectRoot, KAYNAK);
      const set = path.join(platformProjectRoot, projectName, 'Images.xcassets', `${IOS_AD}.imageset`);
      fs.mkdirSync(set, { recursive: true });
      const images = [
        ['nireya-imza.png', '1x'],
        ['nireya-imza@2x.png', '2x'],
        ['nireya-imza@3x.png', '3x'],
      ].map(([dosya, scale]) => {
        fs.copyFileSync(path.join(kaynak, dosya), path.join(set, dosya));
        return { idiom: 'universal', filename: dosya, scale };
      });
      fs.writeFileSync(
        path.join(set, 'Contents.json'),
        JSON.stringify({ images, info: { version: 1, author: 'expo' } }, null, 2)
      );

      // @3x görselin nokta ölçüsü
      const png = fs.readFileSync(path.join(kaynak, 'nireya-imza@3x.png'));
      const w = +(png.readUInt32BE(16) / 3).toFixed(2);
      const h = +(png.readUInt32BE(20) / 3).toFixed(2);

      const sbYol = path.join(platformProjectRoot, projectName, 'SplashScreen.storyboard');
      let sb = fs.readFileSync(sbYol, 'utf8');
      if (sb.includes(IOS_ID)) return cfg;
      const guvenli = /<viewLayoutGuide key="safeArea" id="([^"]+)"/.exec(sb);
      if (!guvenli) throw new Error('Nireya imzası: SplashScreen.storyboard içinde güvenli alan bulunamadı');
      const gorunum =
        `<imageView clipsSubviews="YES" userInteractionEnabled="NO" contentMode="scaleAspectFit" image="${IOS_AD}" ` +
        `translatesAutoresizingMaskIntoConstraints="NO" id="${IOS_ID}" userLabel="${IOS_AD}">` +
        `<rect key="frame" x="0" y="0" width="${w}" height="${h}"/>` +
        `<constraints>` +
        `<constraint firstAttribute="width" constant="${w}" id="NIREYA-Imza-w"/>` +
        `<constraint firstAttribute="height" constant="${h}" id="NIREYA-Imza-h"/>` +
        `</constraints></imageView>`;
      const kisitlar =
        `<constraint firstItem="${IOS_ID}" firstAttribute="centerX" secondItem="EXPO-ContainerView" secondAttribute="centerX" id="NIREYA-Imza-cx"/>` +
        `<constraint firstItem="${guvenli[1]}" firstAttribute="bottom" secondItem="${IOS_ID}" secondAttribute="bottom" constant="${ALT_BOSLUK_PT}" id="NIREYA-Imza-alt"/>`;
      const sonKisit = sb.lastIndexOf('</constraints>');
      if (!sb.includes('</subviews>') || sonKisit < 0) {
        throw new Error('Nireya imzası: storyboard beklenen biçimde değil');
      }
      sb = sb.slice(0, sonKisit) + kisitlar + sb.slice(sonKisit);
      sb = sb.replace('</subviews>', gorunum + '</subviews>');
      sb = sb.replace('</resources>', `<image name="${IOS_AD}" width="${w}" height="${h}"/></resources>`);
      fs.writeFileSync(sbYol, sb);
      return cfg;
    },
  ]);
}

function androidImza(config) {
  return withFinalizedMod(config, [
    'android',
    async (cfg) => {
      const { projectRoot, platformProjectRoot } = cfg.modRequest;
      const res = path.join(platformProjectRoot, 'app/src/main/res');
      for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
        const hedef = path.join(res, `drawable-${d}`);
        fs.mkdirSync(hedef, { recursive: true });
        fs.copyFileSync(path.join(projectRoot, KAYNAK, `android-${d}.png`), path.join(hedef, 'nireya_imza.png'));
      }
      const stilYol = path.join(res, 'values/styles.xml');
      let stil = fs.readFileSync(stilYol, 'utf8');
      if (stil.includes('windowSplashScreenBrandingImage')) return cfg;
      if (!stil.includes('xmlns:tools=')) {
        stil = stil.replace('<resources', '<resources xmlns:tools="http://schemas.android.com/tools"');
      }
      const m = /<style name="Theme\.App\.SplashScreen"[^>]*>/.exec(stil);
      if (!m) throw new Error('Nireya imzası: Theme.App.SplashScreen stili bulunamadı');
      const ek = '\n    <item name="android:windowSplashScreenBrandingImage" tools:targetApi="31">@drawable/nireya_imza</item>';
      stil = stil.slice(0, m.index + m[0].length) + ek + stil.slice(m.index + m[0].length);
      fs.writeFileSync(stilYol, stil);
      return cfg;
    },
  ]);
}

module.exports = function withNireyaImzasi(config) {
  return androidImza(iosImza(config));
};
