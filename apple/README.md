# Attest for Mac and iPhone, and the pendant sync

Three things live here:

- **`PendantKit`** (`Sources/PendantKit`): talks to a Limitless pendant over Bluetooth, copies its audio to disk, cuts it into recordings, and uploads them to your Attest. The Bluetooth protocol is Omi's (MIT), see `NOTICE`.
- **The Attest app** (`App/`, iOS and macOS): your Attest web app in a native shell (so you get the phone layout and its bottom bar: Home, Ask, Record, Recordings, Settings), plus a native **pendant panel** with a **Sync now** button. Open the panel from **Settings > Open pendant sync** inside the app. A small status pill also appears at the bottom right, above the tab bar, only when there is something to report: recordings waiting, a sync running, or an error.
- **`attest-pendant`**: the same sync as a command-line tool for the Mac.

```
apple/
  Package.swift        PendantKit library, attest-pendant CLI, and the tests (swift test)
  project.yml          XcodeGen spec for the two apps; generate.sh makes Attest.xcodeproj from it
  icons.sh             renders App/Shared/Assets.xcassets (app icons) from the SVGs in ../public/icons
  Sources/PendantKit/  protocol, drain engine, journal, segmenter, WebM muxer, outbox, uploaders, Bluetooth
  Sources/attest-pendant/
  Tests/PendantKitTests/   29 tests, with Omi's golden protocol vectors under Fixtures/
  App/Shared/          SwiftUI views, the web view, the pendant model, Keychain
  App/iOS/, App/macOS/ app entry points (iOS also has the background-launch delegate)
```

The Xcode project compiles `PendantKit` straight from `Sources/PendantKit` (two static-library targets) rather than linking the Swift package. Linking a package from inside its own folder makes Xcode report **"Missing package product 'PendantKit'"**. If you ever see that, re-run `./generate.sh` and reopen the project.

## Build

```sh
cd apple
swift test                       # 29 tests, no pendant needed (the WebM test uses ffmpeg if you have it)
brew install xcodegen
./generate.sh                    # makes Attest.xcodeproj (gitignored; regenerate after pulling changes)
open Attest.xcodeproj
swift run attest-pendant help    # the CLI
```

Regenerating resets the project's signing fields to whatever the environment says, so re-run it with your team and bundle id each time (next sections).

## Set Attest up first, then point the app at it

The app is a window onto **your own Attest**, which runs in your Cloudflare account, so that comes first. Setup runs on a computer, not in the app: `npm run setup` in the Attest folder deploys it and logs you in. Tick the pendant when it asks which devices you use, and it also creates the sign-in the app needs and prints:

- your address (`https://attest.example.com`),
- a Client ID and secret, and
- an `attest://connect?...` link. Open that link on your iPhone (AirDrop or Messages it to yourself): the app asks "Connect to attest.example.com?", and one tap fills everything in. Or type the three values into the app's first screen.

If you only use Attest in the app and never the pendant, you only need the address.

**Already deployed before the pendant existed?** Two commands, no need to redo setup:

```sh
npm run deploy         # puts the code that accepts the app's sign-in on your Worker
npm run device-token   # creates the Client ID and secret, and prints them with the link
```

`device-token` asks for your login email and a Cloudflare API token with three Account permissions: *Access: Apps and Policies Edit*, *Access: Organizations, Identity Providers, and Groups Edit*, and *Access: Service Tokens Edit* (dash.cloudflare.com/profile/api-tokens). Do it by hand instead: Zero Trust > Access > Service credentials > Create service token (the secret is shown once); add a **Service Auth** policy for it to your Attest application; then `npx wrangler secret put` for `ACCESS_TEAM_DOMAIN` (your `yourteam.cloudflareaccess.com`), `ACCESS_AUD` (the application's Audience tag) and `OWNER_EMAIL`.

## Sign the app (to run it on your own iPhone)

1. **Xcode signed in.** Xcode > Settings > Accounts > add your Apple ID. Your team appears there.
2. **Pick the team and a bundle id.** A bundle id must be unique across Apple, so `com.attest.app` will usually be taken. Use your own:
   ```sh
   DEVELOPMENT_TEAM=ABCDE12345 ATTEST_BUNDLE_ID=com.yourname.attest ./generate.sh
   ```
   Your team id is the 10 characters under Xcode > Settings > Accounts > (team) or at developer.apple.com/account > Membership details. Or skip it and choose the team in Xcode (next step).
3. **Check signing.** Open `Attest.xcodeproj`, select the **Attest-iOS** target > Signing & Capabilities: tick *Automatically manage signing* and choose your team. The background modes (Bluetooth, background processing) are already in the project, and iOS needs no special entitlement for Bluetooth.
4. **Put the iPhone in developer mode.** Plug it in and trust the computer, then on the phone Settings > Privacy & Security > Developer Mode > on (it restarts).
5. **Run.** Choose your iPhone at the top of Xcode and press Run. The first time, on the phone: Settings > General > VPN & Device Management > your developer certificate > Trust.
6. **Allow Bluetooth** when the app asks, and leave the Settings > Attest > **Background App Refresh** switch on.
7. **Pair once.** With the pendant near and not connected to another app, open **Settings > Open pendant sync** in the app and tap **Sync now**. After that the background sync below can take over.

A **free** (Personal) team works but the app stops opening after 7 days and has to be rebuilt; a paid Apple Developer team lasts a year. To keep it installed and updated without a cable, use **TestFlight**: Product > Archive > Distribute App > App Store Connect, then install from the TestFlight app. TestFlight and the App Store need a paid team and an app record at appstoreconnect.apple.com with a unique bundle id.

For the Mac app: the same steps with the **Attest-macOS** target. It is sandboxed with the Bluetooth entitlement already set.

## Background sync on iPhone

iOS never lets an app run on a schedule it picks, so there are three mechanisms, and together they usually keep up:

1. **The pendant comes back in range.** After you pair once (tap **Sync now** with the pendant near), the app asks iOS to connect to it whenever it is in range and keeps that request alive while the app is closed. When it succeeds iOS relaunches the app in the background and the app drains the pendant. The Bluetooth restore id is `com.attest.pendant`.
2. **Uploads survive.** Finished recordings are handed to a *background URLSession*, which iOS runs itself: uploads finish even if the app is suspended or killed right after, retry on bad networks, and are removed from the queue only when the server confirms them.
3. **A catch-up task.** iOS runs a scheduled background task now and then (typically overnight, on power and Wi-Fi) that tries the pendant and flushes the queue. The timing is iOS's call.

If iOS cuts the app short mid-copy, the drain stops cleanly: what is saved is acknowledged, the rest stays on the pendant and is resent next time. Nothing is lost. What you should *not* expect: a sync every few minutes. If you force-quit the app from the app switcher, iOS stops relaunching it until you open it again. That is an iOS rule.

## Using the app

- **First screen:** the server address, and (for the pendant) the Client ID and secret, or tap the `attest://connect` link. The secret is stored in the iOS Keychain, never in preferences. The address and token can be changed from the pendant panel (**Server and sign-in**).
- **Everything else is your Attest web app**, including its Settings (the gear, or the Settings tab). Choose your devices there; tick **Limitless pendant over Bluetooth** to get the **Open pendant sync** button.
- **Sync now** connects to the pendant, copies its recordings, cuts them into conversations, and uploads them. If the pendant is not in range, whatever is already queued still uploads.
- **Several devices:** the pendant is one source among others (Pocket, Omi, recording in the app). See "Choosing your devices" in the main README.

## Trying it without a pendant

The Simulator has no Bluetooth, but it runs the whole app and the web UI, which is how the layout was checked. Start Attest locally (`npm run local` in the repo root), then:

```sh
xcodebuild -project Attest.xcodeproj -scheme Attest-iOS -destination "id=<simulator id>" -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Attest-iOS.app
xcrun simctl launch booted <your bundle id> -server "http://localhost:8787/"    # launch arguments override the saved server
```

The app allows plain `http://localhost` for this (an App Transport Security exception for local networking only). Your deployed `https://` address is unaffected. Adding `#people` to the address scrolls to the People section, handy for checking that screen.

## How it stays safe

- The pendant keeps its audio until told to delete it. Pages are ACKed **only after they are fsynced to disk** (`Journal`), so a crash, a full disk or a dropped connection never loses audio; the pendant resends what was not ACKed.
- Finished recordings wait in an on-disk **outbox** until the server confirms them. Each has a stable id, so a retry never creates a duplicate.
- The audio is muxed into WebM as-is (no re-encoding), which Attest already plays and transcribes.

## What is and is not verified

Verified by tests (29): Omi's golden protocol vectors byte for byte (commands and parsing), the drain sequence against a scripted fake pendant (ACK safety, stalls, disk failures, cancellation when iOS ends the run), crash-safe storage, an unset pendant clock, WebM output decoded by ffmpeg, uploads against a stub server, a real background `URLSession` taking its body from a file without queuing a recording twice, and the `attest://connect` link (including refusing plain http and odd schemes). Both apps compile for iOS and macOS, and the iOS app was run in the Simulator: the first-run screen, the link handler, and the web UI's phone layout in real iOS WebKit.

**Not yet verified: a real pendant, and real iOS background launches.** Nothing here has been run against hardware, and the Simulator has no Bluetooth, so the wake-on-reconnect and scheduled-task paths are written to Apple's documented behaviour but not exercised. Expect to debug the first real connection and to watch the first few background syncs (Xcode > Debug > Attach to Process, or the Console app on your Mac while the phone is plugged in).
