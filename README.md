# Skydiving and terminal velocity — Vite project

A GCSE forces simulation: a skydiver jumps from a helicopter, reaches terminal velocity, then opens a parachute. Weight, air resistance and the normal contact force are drawn as arrows to scale, with a speedometer, readouts, a velocity–time graph and a step-by-step walkthrough that pauses time at each key moment.

## Setup

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

To build for production:

```bash
npm run build
npm run preview
```

## Structure

- `index.html` — Vite entry HTML (loads the fonts and `src/main.jsx`).
- `src/main.jsx` — React root bootstrap.
- `src/App.jsx` — the simulation: physics model, walkthrough steps, canvas drawing and all React components.
- `src/styles.css` — all styling (always the dark theme).
- `.github/workflows/deploy.yml` — builds and deploys to GitHub Pages on every push to `main`.

## Things you might want to tweak (top of `src/App.jsx`)

- `BODY` and `CANOPY` — surface areas and drag coefficients (freefall terminal velocity is about 50 m/s at 75 kg).
- `MASS`, `DRAG` — slider ranges.
- `PX_PER_M` — how fast the skydiver moves across the sky panel.
- `ARROW` — force arrow scale and the longest arrow drawn before it is marked "not to scale".
- `STEPS` and `explain()` — the walkthrough moments and their text.

## Deploying to GitHub Pages

1. In `vite.config.js`, `REPO_NAME` is set to `skydiver`. Change it if your repo has a different name.
2. Push this project to a GitHub repo, on branch `main`.
3. In the repo's Settings → Pages, set **Source** to "GitHub Actions".
4. The workflow builds the project and publishes `dist/` on every push to `main`.
