# WorkFlow Recorder: setting it up

WorkFlow Recorder is a small app for your Pixel. It records a meeting, transcribes it on the phone with
NVIDIA's Parakeet speech model, and sends the transcript to WorkFlow. Audio never leaves the phone.

It needs a web address to live at. GitHub Pages hosts it for free. GitHub only stores the app's own files:
no recordings, transcripts or student information ever go there. This takes about 15 minutes, once.

## 1. Put the app on GitHub Pages (on a computer or Chromebook)

1. Go to **github.com** and create a free account (or sign in).
2. Press **+** (top right) › **New repository**.
   - Name: `workflow-recorder`
   - Choose **Public** (free GitHub Pages sites must be public; the app's code is all that's there).
   - Press **Create repository**.
3. On the new repository's page, press **uploading an existing file**.
4. Open the `recorder` folder from the WorkFlow zip. Select **everything inside it** (the files *and* the
   `icons` and `vendor` folders) and drag it all onto the GitHub page. Wait until every file is listed;
   the two largest files are about 12 MB and 24 MB, so this can take a minute.
5. Press **Commit changes**.
6. Go to **Settings** (the repository's tab) › **Pages**. Under *Branch*, choose **main** and **/ (root)**,
   then **Save**.
7. After a minute or two, the page shows your address, like
   `https://yourname.github.io/workflow-recorder/`. Open it to check: you should see *WorkFlow Recorder*.

## 2. Tell WorkFlow where it is

In WorkFlow, open **Settings › WorkFlow Recorder**, paste the address, and leave the box. Meetings now have a
**Record on this phone** button.

## 3. Set it up on your Pixel (on Wi-Fi)

1. In WorkFlow on the Pixel, open any meeting and tap **Record on this phone**. The Recorder opens in Chrome
   and shows **Connected**: this connected it to your WorkFlow.
2. In Chrome's menu (⋮), tap **Add to Home screen** › **Install**. Installing it is what puts WorkFlow
   Recorder in the Share menu of other apps, like Pixel Recorder.
3. Open **Settings and privacy** in the Recorder and tap **Download the speech model now**. This is a
   one-time download: about 1.2 GB in Fast mode, or 650 MB in Compatible mode. Keep the screen on until it
   finishes.
4. Allow the microphone the first time you tap **Record**.

## 4. Try it

1. Record a minute or two of normal talk, then **Stop**. It starts transcribing by itself; note how long it
   takes. Under a quarter of the recording's length is a good sign for full meetings.
2. Tap **Send to WorkFlow**. You land on the meeting in WorkFlow with the transcript attached, and the
   names and school terms fixed.
3. Privacy check: turn on **airplane mode**, record a short clip, and transcribe it. It still works, because
   everything happens on the phone.

If **Send to WorkFlow** ever shows a Google sign-in page instead of WorkFlow, sign in and try again. If it
still won't go through, tap **Share as a file** and save it to **WorkFlow › Inbox** in Drive: the file name
carries the meeting, so it lands on the same meeting. The audio stays on the phone for 3 days after sending,
so nothing is lost while you sort it out.

## Good to know

- **Keep the Recorder on screen while recording and transcribing.** The screen stays on by itself. Android
  can stop a recording if you switch to another app for a long time; if that happens, everything up to then
  is saved, and the Recorder says so.
- **Recordings from Pixel Recorder:** in Recorder, open the recording › **Share** › **Audio file** ›
  **WorkFlow Recorder**. Opened from a meeting first, it goes on that meeting; otherwise WorkFlow matches it
  to your calendar by time.
- **Spanish and other languages:** Settings and privacy › Language › *English + 24 more*. That's a separate
  download.
- **Speed:** *Automatic* uses the phone's graphics chip when it can (Fast) and the processor otherwise
  (Compatible). If Fast fails to load, it switches to Compatible by itself.
- **A new phone, or a lost one:** in WorkFlow, Settings › WorkFlow Recorder › **Make a new pairing code**.
  The old phone can no longer send anything; tap Record on this phone on the new one.

## Updating the Recorder later

Upload the changed files to the same repository the same way (**Add file › Upload files**, then **Commit**).
The Recorder picks up the new version the next time it's opened; open it twice if you don't see a change.

## What's inside

| File | What it is |
| --- | --- |
| `index.html`, `app.js`, `styles.css` | The app |
| `audio.js`, `recorder-worklet.js` | Recording, and reading files shared in from other apps |
| `storage.js` | Saving recordings on the phone as you go |
| `engine.js`, `vendor/engine-worker.js` | The speech engine (parakeet.js 1.4.4 with ONNX Runtime Web 1.24.1, MIT) |
| `vendor/ort/` | ONNX Runtime's WebAssembly files |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installing, working offline, and the Share menu |
| `engine-worker.src.js` | The source of `vendor/engine-worker.js` (rebuilt with `tools/build_recorder.js`) |

The speech model itself (NVIDIA Parakeet TDT 0.6B, CC BY 4.0) isn't in the repository: the phone downloads it
from Hugging Face the first time and keeps it.
