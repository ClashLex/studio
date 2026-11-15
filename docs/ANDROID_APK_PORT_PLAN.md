# Android APK Port Plan

## Scope and goal

This branch, `feature/android-port`, is for packaging zoxilsi studio as an
Android app. iOS is explicitly out of scope for this phase and can be handled
on a separate branch or follow-up after the Android workflow is stable.

The goal is to reuse the existing Next.js/React editor inside a Capacitor
Android WebView, not to rewrite the editor in a native UI framework. The first
milestone is a locally installable debug APK. The release milestone is a
signed Android App Bundle (AAB) for Google Play, with a signed APK available
when direct APK distribution is needed.

## Current project fit

- `next.config.ts` already configures `output: "export"`, so a production build
  emits static web assets to `out/`.
- The editor is client-rendered and its core rendering uses Three.js/WebGL2.
- The compact layout already has drawers and pointer-based mesh editing.
- Image/video downloads and project imports currently use browser APIs. Those
  workflows need testing and likely native integration in an Android WebView.
- The current document itself is not automatically persisted. A mobile process
  can be suspended or killed, so draft recovery should be addressed before a
  store release.
- Capacitor configuration and the generated Android project are in place. The
  debug APK builds successfully; installation and runtime validation on an
  emulator or physical device remain.

## Proposed architecture

1. Keep the existing React editor and static-export build.
2. Add Capacitor core, CLI, and Android platform packages.
3. Configure Capacitor to package `out/` as the local WebView content; do not
   point the production app at the hosted website.
4. Generate the native Android project with Capacitor and use Android Studio /
   Gradle for emulator runs, APK builds, and release signing.
5. Add Capacitor plugins only where platform behavior is needed (for example,
   native Android save or app lifecycle), keeping browser behavior available
   for the web deployment.

The Android application ID should be based on the project's domain. The
initial scaffold may use `cc.zoxilsi.studio`; confirm ownership and the final
store identity before publishing, because the application ID is difficult to
change after release.

## Work plan

### Phase 1 — Android shell and repeatable debug APK

- Add Capacitor dependencies and a typed `capacitor.config.ts`.
- Set the web output directory to `out/` and add package scripts for build,
  sync, Android open, and Android build tasks.
- Generate the `android/` project using the Capacitor CLI.
- Confirm generated resources and routing work when served from the native
  WebView, not only from `localhost`.
- Document required local tooling: Android Studio, Android SDK/platform tools,
  and a JDK version supported by the generated Gradle/Android Gradle Plugin.
- Verify the first debug APK installs and launches on an emulator and a
  physical device.

**Acceptance:** one documented command sequence builds the static site,
synchronizes it into the Android project, and produces an installable debug
APK with the editor loading from the packaged assets while offline.

### Phase 2 — Android file workflows

- Exercise PNG/JPG/WebP export, project JSON export/import, and code export on
  emulator and physical devices.
- Save Android exports directly to `Documents/zoxilsi studio/exports` where
  the WebView does not reliably expose browser downloads.
- Verify the Android document picker can open project files and that import
  errors remain visible to the user.
- Keep the current browser paths intact for the website.

**Acceptance:** users can export an image/video/project to an accessible
Android destination and import a saved project through the system picker.

### Phase 3 — Mobile resilience and usability

- Add draft autosave/recovery for the active mesh document and restore it after
  app relaunch; define how this interacts with imported documents and undo
  history.
- Keep the status bar visible and extend the Android app background behind the
  bottom navigation area; inset bottom controls while leaving the website layout
  unchanged.
- Review touch target sizes, color-picker gestures, drawer behavior, keyboard
  visibility, and portrait/landscape layouts.
- Detect unsupported or lost WebGL contexts and show a useful recovery message.
- Add device-aware export limits: validate WebGL maximum texture size and
  memory-sensitive resolutions rather than assuming desktop-class GPU
  capacity.
- Test playback pause/resume and rendering after backgrounding and foregrounding
  the app.

**Acceptance:** the editor remains usable on a small phone in portrait and
landscape, recovers the last draft after process termination, and fails safely
when the device cannot support a requested render.

### Phase 4 — Compatibility, privacy, and store preparation

- Test a representative Android/API matrix, including low-memory hardware,
  current Android System WebView, and supported Android versions.
- Verify `MediaRecorder`, `canvas.captureStream`, WebGL2, `toBlob`, clipboard,
  file input, and native save behavior on real devices. Video recording
  should have a clear fallback if unsupported.
- Review Vercel Analytics, Microsoft Clarity, external support links, and
  payment/donation flows for privacy disclosures and Google Play policy.
- Generate native adaptive launcher icons and splash assets; validate app name,
  orientation, theme/status bar, and navigation behavior.
- Add Android build checks to CI after the local toolchain is established.

**Acceptance:** release checklist covers supported devices, privacy disclosures,
signing, app metadata, and the behavior of every advertised export format.

### Phase 5 — Release artifacts

- Keep debug signing for local development only.
- Create and securely store a release signing key outside the repository and
  CI logs; configure signing credentials as protected CI secrets if automated
  release builds are added.
- Build and test a release APK for direct installation.
- Build a signed AAB for Google Play and test it through an internal track.
- Keep the application ID stable after first publication.

**Acceptance:** a reproducible signed release artifact is produced without
committing keystores or credentials.

## Initial local workflow

Install Android Studio, the Android SDK/platform tools, and a JDK supported by
the generated Gradle toolchain (JDK 21 for Capacitor 8). On Windows, point the
build at Android Studio's bundled JDK and the SDK if they are not on `PATH`:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

Then run:

```powershell
pnpm install --frozen-lockfile
pnpm android:build
```

`android:build` builds the static site, syncs it into the Android project, and
runs Gradle `assembleDebug`. The debug APK is written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

To open the native project in Android Studio instead, run:

```powershell
pnpm android:sync
pnpm android:open
```

For command-line builds, use the Gradle wrapper generated in `android/` and
verify the exact task name against that generated project. Release signing is
intentionally a later phase.

## Risks and decisions to resolve

- The current machine is Windows and does not appear to have Android SDK
  variables or Android command-line tools configured. Java is present, but its
  version must be checked against the generated Gradle toolchain.
- WebGL2 and high-resolution offscreen renders can exceed mobile GPU or memory
  limits; desktop success does not establish phone compatibility.
- `MediaRecorder` and video MIME support vary by Android WebView/device.
- Browser downloads are not a substitute for a tested native save UX.
- The final application ID and supported Android minimum version must be
  confirmed before release.
- This plan does not create an iOS target; iOS work is deferred.
