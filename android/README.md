# IPtasK Android app (TWA)

A Trusted Web Activity: a small Android app that opens https://iptask.vercel.app full screen in Chrome.
Generated with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap). Updates to the web app reach
installed phones without a new APK; rebuild only to change the name, icon, version or package.

- `project/` — the Android project (`twa-manifest.json` holds the settings).
- `signing/` — the signing key and its password. **Not in Git. Back it up**: every future APK must be signed
  with this same key, or phones refuse to update the app.
- `public/.well-known/assetlinks.json` (web app) lists this key's SHA-256 fingerprint so the app opens
  without the browser address bar.

Rebuild (Windows, JDK 17 and the Android SDK installed):

```powershell
cd android/project
.\gradlew.bat assembleRelease
$bt = "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0"
& "$bt\zipalign.exe" -f -p 4 app\build\outputs\apk\release\app-release-unsigned.apk aligned.apk
& "$bt\apksigner.bat" sign --ks ..\signing\iptask.keystore --ks-key-alias iptask --out ..\IPtasK.apk aligned.apk
```

Raise `appVersionCode` / `versionCode` in `app/build.gradle` (and `twa-manifest.json`) for each new APK.
