# Daraja Android App

This project includes a Capacitor Android wrapper in `android/`.

For local school testing, the app opens:

`http://136.112.61.134/app/`

That means the portal server must be running on the laptop and the phone must be on the same Wi-Fi.

## Build Requirements

Install these on the build machine:

- Java JDK 17 or newer
- Android Studio, including Android SDK and build tools

After installing Android Studio, open the project once so it can finish SDK setup.

## Build Commands

From the portal folder:

```powershell
npm run android:sync
npm run android:open
```

In Android Studio, click **Run** to install on a connected phone, or use:

```powershell
npm run android:build
```

The debug APK will be created under:

`android/app/build/outputs/apk/debug/`

## Changing The Server URL

Edit `capacitor.config.json`:

```json
"server": {
  "url": "http://136.112.61.134/app/",
  "errorPath": "offline.html",
  "cleartext": true
}
```

For production, replace the LAN URL with the school's HTTPS domain, then run:

```powershell
npm run android:sync
```
