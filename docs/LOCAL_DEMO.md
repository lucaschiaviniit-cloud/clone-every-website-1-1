# Synthetic local demonstration

The included fixture is a generic test page, with an OFL-licensed Inter font. It is not a copied customer website. This demonstration exercises deterministic capture and replay only; it does not demonstrate independent source reconstruction or a real-site speedup.

After installing dependencies and Chromium, run from the repository root:

```sh
npm --prefix tools/lab run capture:fixture -- --out ../../runs/synthetic-demo
npm --prefix tools/lab run build:variants -- --capture ../../runs/synthetic-demo --variant v2
npm --prefix tools/lab run eval -- --capture ../../runs/synthetic-demo --variant v2
npm --prefix tools/lab run serve -- --capture ../../runs/synthetic-demo --variant v2 --port 4173
```

The first command starts and closes a local fixture server automatically. The last command stays running and prints the preview address. Open `http://127.0.0.1:4173/`, inspect the menu and layout, then stop it with Ctrl+C.

Use a fresh output path if repeating the demonstration. The generated `runs/` folder is ignored by Git. This lower-level engine example is not a normal user-approval record and must not be reused to skip the skill's review gate.

## Bundled placeholder video

The release includes an eight-second 720×1280 H.264 video without audio, generated solely from a solid background and a fading geometric shape. It contains no extracted website footage, stock media, font, logo or model.

Provenance and SHA256: [provenance.json](../tools/lab/assets/media/provenance.json). With FFmpeg available, regenerate it from the repository root:

```sh
node scripts/generate-placeholder-video.mjs
```

The generator updates the video and its provenance together. Encoder versions can produce different bytes; decoding, duration, dimensions and offline playback are the compatibility contract.
