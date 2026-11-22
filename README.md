# Razy — Musical Player

Razy is an ad-free music player inspired by Spotify, with a desktop app and an Android version.

## Android APK

The repository contains a GitHub Actions workflow at `.github/workflows/android.yml`.

After the full project source has been uploaded to the repository:

1. Open **Actions → Build Android APK**.
2. Select **Run workflow** (or push a new commit to `main`).
3. Wait for the workflow to finish successfully.
4. Open the workflow run and download the **Razy-Android** artifact.
5. Extract the downloaded ZIP. The Android installer is `app-debug.apk`.

The APK is debug-signed for testing and manual installation. It is not a Play Store release build.

## Required source files

The workflow expects the complete project layout, including `app/`, `assets/`, `main.js`, `config.json`, and the `mobile/` directory from the supplied project archive. Uploading only this README and workflow is not enough to build the app.

## Optional shared music server

Set the repository variable `RAZY_SERVER_URL` under **Settings → Secrets and variables → Actions → Variables** to configure a public shared Razy server URL during the Android build.

## Project structure

- `app/` — application interface
- `main.js` — desktop and shared network logic
- `mobile/` — Capacitor Android wrapper and native music-library plugin
- `server/` — optional shared music server
- `.github/workflows/android.yml` — Android APK build
