# CoScene

A multiplayer version of the [three.js editor](https://threejs.org/editor/): everyone who opens the same URL edits one shared 3D scene in real time, with SpacetimeDB as the backend.

> **Status:** the client runs the stock three.js editor (r187) under Vite. It's not connected to SpacetimeDB yet, so for now every browser has its own scene.

## Run the client

**You need:** [Node.js](https://nodejs.org/) 20 or newer (check with `node --version`) and git.

```sh
git clone git@github.com:hendohpp/hackutd-2026.git
cd hackutd-2026/client
npm install
npm run dev
```

Open **http://localhost:5173**. You should see the three.js editor.

### Quick check that it works

1. **Add → Mesh → Box.** A box appears, selected.
2. Drag the colored arrows to move it. Press **E** to rotate and **R** to scale.
3. Change its color in the right sidebar: **Material** tab → **Color**.
4. Open DevTools (F12) → **Console**. There should be no red errors.

### Troubleshooting

- **`Port 5173 is already in use`**: another dev server is still running. Stop it (Ctrl+C in its terminal) and run `npm run dev` again.
- **On WSL, the page won't load in your Windows browser**: run `npm run dev -- --host` and open the `Network:` URL it prints.
- **An old scene keeps coming back**: the editor still saves to your browser's local storage (this goes away once SpacetimeDB is connected). Use **File → New → Empty** to clear it.
- **Something seems broken after pulling new changes**: run `npm install` again, then restart `npm run dev`.

## Project layout

```
client/
  editor/        the three.js editor (r187), lightly modified; this is the web root
  src/           our code (multiplayer.js: where the SpacetimeDB client will live)
  public/        static files the editor expects (favicons, font)
  vite.config.js
server/          SpacetimeDB module (coming soon)
```

Every place in the editor that will call a SpacetimeDB reducer is marked with a `#SPACETIME` comment:

```sh
grep -rn "#SPACETIME" client/
```

## Credits

The editor in `client/editor/` is the [three.js editor](https://github.com/mrdoob/three.js/tree/dev/editor) by the three.js authors, released under the MIT License. See [LICENSE-threejs](LICENSE-threejs).
