# Claude Keeper — showcase site

A self-contained, dependency-free static site for showcasing Claude Keeper:
what it is, why to use it, how it works, an interactive auto-resume demo, UX
use-cases, and getting-started instructions.

## Files

- `index.html` — the full landing page
- `assets/style.css` — GitHub-dark theme
- `assets/app.js` — interactive demo (animated state machine + countdown), tabs, scroll reveals
- `assets/logo.svg` — logo / favicon
- `.nojekyll` — tells GitHub Pages to serve `assets/` verbatim

## Preview locally

```sh
# from the repo root
npx serve site        # or: python -m http.server -d site 8080
```

Then open the printed URL.

## Host on GitHub Pages

1. Push the repo to GitHub.
2. Settings → Pages → Build and deployment → **Deploy from a branch**.
3. Choose your branch and set the folder to **/ (root)**, then move/copy the
   `site/` contents to the repo root *or* use a Pages action that publishes the
   `site/` directory.

Alternatively, publish `site/` with any static host (Netlify, Vercel,
Cloudflare Pages, S3) — there is no build step.
