# Pocket Player

An ad-free music and video player for Android. GitHub builds the APK for you every time you upload a change.

## Get the APK (works from your phone)

1. Sign in to [github.com](https://github.com) and create a new repository called `pocket-player`. Private is fine.
2. Tap **Add file › Upload files**, choose `pocket-player-android.zip` (don't unzip it), then **Commit changes**.
3. Tap **Add file › Create new file**. Name it exactly `.github/workflows/build-apk.yml`, paste in the contents of `build-apk.yml`, then **Commit changes**.
4. Open the **Actions** tab. The **Build APK** run starts by itself and takes about 5–8 minutes.
5. When it shows a green tick, open **Releases** on the repository's main page, then **Pocket Player 1.x**, and tap **PocketPlayer.apk** to download it.
6. Open the downloaded file. If Android asks, allow your browser to install unknown apps, then tap **Install**.

From a computer you can instead unzip the project and push the folder's contents with git:

```
cd pocket-player-android
git init -b main
git add .
git commit -m "Pocket Player"
git remote add origin https://github.com/YOUR-NAME/pocket-player.git
git push -u origin main
```

## Updating the app

Upload a new `pocket-player-android.zip` (replacing the old one), or change `www/index.html` and push it if you used git. Each build gets a higher version number and is signed with the same key in `keystore/`, so it installs over the previous version and keeps your settings. You can also start a build by hand: **Actions › Build APK › Run workflow**.

## What the app can do

- Finds every song and video on the phone automatically (asks for permission the first time). Tap **Rescan phone** after adding new files.
- Album art and video thumbnails, favourites, sorting, search, shuffle, repeat, sleep timer, A–B loop, speed control.
- 10-band equalizer, video tools (pop-out, rotate, zoom, picture adjustments, subtitles), light and dark themes.
- Keeps playing with the screen off. The back button sends the app to the background instead of stopping it.
- **Hearing boost**: only starts when Bluetooth earbuds are connected, and stops by itself if they disconnect.

## About the signing key

`keystore/pocket-player.jks` (password `pocketplayer`) signs every build so updates install cleanly. Anyone who can see the repository can sign apps with it, so keep the repository **private** if you share your GitHub account or plan to give the app to others.

## Project layout

- `www/index.html`: the whole player (the same page as the web version)
- `native/java/`: Android code for the phone scan, earbud check and background playback
- `native/res/`: app icon
- `scripts/customize-android.mjs`: adds the native code, permissions, icon and signing to the Android project during the build
- `.github/workflows/build-apk.yml`: the GitHub build
