# Pocket Player for Windows

An ad-free music and video player for your PC. GitHub builds the installer for you.

## Get the app

1. On github.com, create a new repository called `pocket-player-pc` (Private is fine).
2. Tap **uploading an existing file**, upload `pocket-player-desktop.zip` as it is, and **Commit changes**.
3. **Add file › Create new file**, name it `.github/workflows/build-windows.yml`, paste in the contents of `build-windows.yml`, and **Commit changes**.
4. Open **Actions** and wait for **Build Windows app** to show a green tick (about 5–10 minutes).
5. Open **Releases › Pocket Player for Windows**, download **PocketPlayer-Setup-1.0.x.exe** and run it.

Windows SmartScreen warns about apps that aren't code-signed. Click **More info › Run anyway**.

## What it does on a PC

- Finds every song and video in your Music and Videos folders, plus any folder you add with **Add folder**. New files show up by themselves.
- Reads song titles, artists, albums and album art from the files. **⋯ › Edit details** fixes them (saved into MP3 files).
- **Lyrics**: found online automatically (from the free LRCLIB library), or press **+ Lyrics** on the record to paste them in and tap along to time each line. Saved as an `.lrc` file next to the song. Press **Y** to show or hide.
- **Playlists**: make them from the ⋯ menu, drag songs to reorder, import and export `.m3u` files. **Play next** and **Add to queue** too.
- **Mini player**: a small always-on-top window (Ctrl+Alt+M).
- **System tray**: closing the window keeps the music playing; right-click the tray icon for controls.
- **Taskbar**: previous / play / next buttons when you hover the taskbar icon, and song progress on the icon.
- **Global hotkeys** that work in any app: Ctrl+Alt+Space, Ctrl+Alt+← / →, Ctrl+Alt+↑ / ↓, Ctrl+Alt+L.
- **Crossfade**, **even out volume**, and a **sound output** picker (speakers, headphones, TV).
- **Full-screen visualizer** (V) in Boxy or Rings style and a monthly **listening stats** page.
- **Sleep timer** can pause music, put the PC to sleep, or shut it down (with a 60-second cancel).
- Song-change notifications, start with Windows, and Discord "Listening to" status.
- Right-click a music or video file › **Open with › Pocket Player** to play it.
- **Download from a link**: paste a link (or press Ctrl+V anywhere, or drag a link in) to download music and videos with progress, cancel and retry. Works with direct file links, Dropbox and Google Drive share links, and web pages with audio or video on them. Streaming services such as YouTube and Spotify don't allow downloads.
- **Internet radio**: thousands of live stations by name, genre or country; save your favourites.
- **Podcasts**: search, subscribe, stream episodes or download them.
- **Albums and Artists** views, **smart playlists** (Recently added, Most played, Not played yet), an editable **Up next** queue, and a keyboard shortcut list (press ?).
- Everything from the other versions: equalizer, speed, video tools, themes, favourites and Hearing boost.

## Files

- `main.js`: the desktop window, folder scanning, tags and album art
- `preload.js`: the bridge between the window and the player page
- `www/index.html`: the player
- `build/`: app icon
