# Attest for Android

Your Attest web app in a native Android shell, like the iPhone app in [`../apple`](../apple/README.md) but without the Bluetooth pendant:

- **The whole app.** Home, Ask, Record, Library and Settings with the phone layout and bottom tab bar. Sign-in (Cloudflare Access) happens inside the app and the session is kept.
- **Record** on the Record tab. Android asks for the microphone the first time.
- **Share > Upload to Attest** from any app: a voice recorder, Files, WhatsApp, an email attachment. The upload runs in the background (WorkManager): it waits for a network, survives the app being closed or the phone rebooting, and keeps retrying server and network errors for about two days. It gives up straight away if the server refuses the sign-in or rejects the file, and then you get a notification (the only one the app sends). The recording is dated when you share it, not when it was recorded.
- **Export .md / .docx / .zip** save to Downloads, and **Print / PDF > Save as PDF** opens Android's print dialog (choose *Save as PDF* there).
- **One-tap setup** with the same `attest://connect?...` link the iPhone app uses.

No developer account or fee is needed to install it on your own phone: build the APK and sideload it.

```
android/
  app/src/main/java/com/attest/app/
    MainActivity.kt    the web view: mic permission, file upload, downloads, connect links, offline screen
    SetupActivity.kt   server address and the optional Access service token
    ShareActivity.kt   receives shared audio/video, copies it in, queues the upload
    UploadWorker.kt    the background upload (multipart POST /api/recordings)
    Connect.kt         address rules and attest://connect parsing (plain Kotlin, unit tested)
    Multipart.kt       the upload form and what each HTTP status means (plain Kotlin, unit tested)
    Store.kt           settings; the token secret is encrypted with an Android Keystore key
  app/src/test/        JUnit tests (./gradlew test)
```

## Build

You need **Android Studio** (it brings the Android SDK and a Java runtime). Either open the `android/` folder in Android Studio and press Run, or from a terminal:

```sh
cd android
./gradlew test lint assembleDebug   # Windows: gradlew.bat test lint assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/app-debug.apk`. If Gradle cannot find Java, point `JAVA_HOME` at Android Studio's runtime (Windows: `C:\Program Files\Android\Android Studio\jbr`; Mac: `/Applications/Android Studio.app/Contents/jbr/Contents/Home`). If it cannot find the SDK, create `local.properties` with `sdk.dir=` and your SDK path (Android Studio > Settings > Languages & Frameworks > Android SDK shows it).

Requires Android 10 or newer.

## Install it on your phone

1. **Developer options**: Settings > About phone > tap *Build number* seven times.
2. **USB debugging**: Settings > System > Developer options > USB debugging on. Plug the phone in and allow the computer.
3. `adb install app/build/outputs/apk/debug/app-debug.apk` (adb is in the SDK's `platform-tools`), or press Run in Android Studio with the phone selected.

Or copy the APK to the phone and open it; Android asks you to allow installing from that app once.

A debug build is signed with your computer's debug key, which is fine for your own phone. To hand the app to other people or publish it, build a release with your own key (Android Studio > Build > Generate Signed App Bundle or APK). For Google Play the application id `com.attest.app` will be taken: change it in `app/build.gradle.kts` and `res/xml/shortcuts.xml`.

## Publishing (F-Droid, Google Play)

Not published anywhere yet. The pieces both stores read are here:

- `fastlane/metadata/android/en-US/` holds the store title, descriptions, changelog, icon and screenshots. F-Droid reads them straight from the repo, and they can be uploaded to Play.
- `fdroid/com.attest.app.yml` is a draft F-Droid build recipe.

**F-Droid** (free, builds from this source):
1. Tag the release commit: `git tag android-v0.1 && git push origin android-v0.1`. Bump `versionCode`/`versionName` in `app/build.gradle.kts`, and add `changelogs/<versionCode>.txt`, for each later release.
2. Fork https://gitlab.com/fdroid/fdroiddata and copy the recipe to `metadata/com.attest.app.yml`. Check it with `fdroid lint` / `fdroid build -v -l com.attest.app` if you have fdroidserver, then open a merge request. Alternatively, open a "Request for packaging" issue at https://gitlab.com/fdroid/rfp and let the F-Droid volunteers do it.
3. F-Droid signs the APK with its own key, and updates follow new `android-v*` tags automatically.

**Google Play:**
- A unique application id (change it in `app/build.gradle.kts` and `res/xml/shortcuts.xml` *before* the first release on any store, because it can never change afterwards).
- A release signing key kept out of the repo, and an `.aab` (`./gradlew bundleRelease`).
- A privacy policy URL.
- The Data safety and content rating forms.
- A demo Attest server with a login for the reviewers.
- Personal developer accounts created after November 2023 must first run a closed test with 12+ testers for 14 days in a row.

## Point it at your Attest

The app is a window onto **your own Attest**, so that comes first.

- **Cloudflare (the normal setup).** Deploy with `npm run setup` (README > Quick start). Open the app, type your address (`https://attest.example.com`) and tap Connect, then sign in with Cloudflare Access inside the app. If you ticked the pendant during setup, or ran `npm run device-token`, setup also printed an `attest://connect?...` link: open it on the phone (message or email it to yourself) and the app fills in everything after you confirm the address.
- **A local Attest on your computer** (`npm run local`). Your phone has to reach the computer over **https** (the microphone only works on a secure page, and the app refuses plain http except to the phone itself). Two ways:
  - **USB cable, for trying it out:** `adb reverse tcp:8787 tcp:8787`, then use `http://localhost:8787` in the app. Works only while the phone is plugged in.
  - **Anywhere on your own devices:** [Tailscale](https://tailscale.com) on both, then `tailscale serve --bg 8787` on the computer. Use the `https://<computer>.<tailnet>.ts.net` address it prints.

Change the server later: long-press the app icon > **Server and sign-in**, or tap it on the screen the app shows when it cannot reach the server.

### Sign-in and Share uploads

The app itself signs in like a browser. Shared files are uploaded by a background job, which uses that same sign-in (the app's Access cookie) when there is no service token. If your Access session has expired, the upload fails with "the server refused the sign-in": open the app once to sign in again and share the file again. To make shared uploads independent of the login, add the **Client ID and secret** that `npm run device-token` prints (or use the connect link). A local Attest needs neither.

**Google sign-in:** Google does not allow its login page inside apps' web views. If your Access login uses Google, add the **One-time PIN** login method in Cloudflare Zero Trust (Settings > Authentication) and use that in the app.

## Good to know

- **A shared recording is transcribed when you open it** in the app or the browser (Library > the recording), the same as a file uploaded with the web app's *Upload audio*. Opening it is what starts transcription and the summary.
- **Each shared file stays its own recording.** The app deliberately does not send the pendant's `ingest_id`, because Attest joins `ingest_id` uploads that are minutes apart into one conversation. The cost: if the server stored a file but the phone never got the answer, the retry makes a second copy, which you can delete.
- **Recording with the app in the background.** Recording carried on when we pressed Home for a few seconds, but that has not been tested for long recordings or with the screen locked. Android can silence the microphone of an app in the background. For a long meeting, keep Attest open on screen, or record with your phone's voice recorder and share the file to Attest.
- **Back** goes back a page when there is one (for example from Print / PDF). Moving between tabs and recordings inside Attest does not add pages, so from there Back leaves the app; use the app's own back arrows.
- **Not supported yet:** the Limitless pendant (iPhone and Mac only), and *blob* downloads such as saving the mind map as an image.

## Tested

On the Android 17 emulator (Pixel 10 Pro XL image) against a local Attest through `adb reverse`:

- First run, the connect link and its confirmation.
- The phone layout and tabs.
- The microphone prompt and an in-app recording that uploaded.
- Share > Upload to Attest with one file and with two files at once (two separate recordings).
- Opening a shared recording, which was transcribed with two speakers and summarized in about a minute.
- Export .md to Downloads, and Print / PDF opening the print dialog with a correct preview.
- Back from a page.
- 10 unit tests, and Android lint with no errors (it checks that nothing needs a newer Android than 10).

**Not tested:** a real phone, Android 10 to 16 (only the Android 17 emulator image was available), a Cloudflare deploy behind Access (sign-in inside the app, the cookie and service-token uploads), Tailscale, and long background recordings.
