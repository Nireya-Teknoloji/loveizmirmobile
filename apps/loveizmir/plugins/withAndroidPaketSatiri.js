// Expo prebuild, uygulama adındaki "İ" yüzünden şablonu com/lovezmir klasörüne ama Kotlin'de "package com.loveizmir"
// ile yazıyor; paket yeniden adlandırması "com.lovezmir"i aradığı için package satırı eski kalıyor ve Release
// derlemesi "Unresolved reference 'BuildConfig'" ile düşüyor (2026-11-15). MainActivity/MainApplication'daki
// package satırını app.json › android.package ile eşitler.
const { withMainActivity, withMainApplication } = require('expo/config-plugins');

function duzelt(cfg) {
  const paket = cfg.android?.package;
  if (paket && cfg.modResults.language === 'kt') {
    cfg.modResults.contents = cfg.modResults.contents.replace(/^package\s+[\w.`]+/m, `package ${paket}`);
  }
  return cfg;
}

module.exports = (config) => withMainApplication(withMainActivity(config, duzelt), duzelt);
