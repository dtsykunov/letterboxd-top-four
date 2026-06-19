# Letterboxd Top Four — Favorite Films Picker

**Live:** https://dtsykunov.github.io/letterboxd-top-four/

A free, private static web app that helps you choose your **four favorite Letterboxd films**
— the "Favorite films" / **top 4** on your profile — by ranking the films you've watched
through a series of quick head-to-head matchups. Everything runs locally in your browser.

## Privacy

Everything runs entirely in your browser. Your Letterboxd data is never uploaded to any server, sent to any API, or stored anywhere outside your own device. The only external requests are the "View on Letterboxd" links, which open in a new tab when you click them.

## How to use

1. **Export your Letterboxd data.**
   Go to [letterboxd.com/settings/data](https://letterboxd.com/settings/data) and click "Export your data". You'll receive a `.zip` file.

2. **Open the app** and click "Get started".

3. **Upload your file.**
   Drop the `.zip` directly onto the upload area, or use the file picker. You can also upload just the `watched.csv` from inside the zip if you prefer.

4. **Pick your favorites.**
   For each matchup, click the film you prefer (or tap the card, or press `←`/`→`). Progress is saved automatically — you can close the tab and resume later.

5. **See your results.**
   After enough comparisons, you'll see your films ranked #1 through #4. Each links to its Letterboxd page.

## How the ranking works

The app runs a **single-elimination tournament** over all the films you've watched to find #1, then uses a repechage (losers bracket) to find #2, #3, and #4. Films that were only beaten by already-ranked films become candidates for the next slot, so every film gets a fair shot. Pairings within each round are randomized.

Assuming your preferences are consistent (if you prefer A over B and B over C, you also prefer A over C), the result is your true top 4.

The number of comparisons scales gently: roughly N + 3·log₂(N) matchups for a list of N films.

On the results screen, **Show full ranking** reveals places 5 and beyond. Because those films
were only partially compared, they can't be strictly ordered, so they're ranked by **matchups
won** — which honestly produces **ties**. Films that share a win count share a place (standard
"1224" competition ranking), and each shared placing is labelled as a tie.

## Progress & the tournament graph

While picking, you always see which favorite you're deciding (**#k of 4**) and an exact
**matchup X of Y** progress bar for the current favorite. (A single-elimination of *m*
candidates is always exactly *m−1* matchups, so per-favorite progress is exact. The grand
total across all four favorites is *not* knowable in advance — it depends on your picks — so
it isn't shown as a fake countdown.)

An optional **tournament graph** (toggle on the matchup screen, remembered across reloads)
shows the rounds as columns: decided matchups with their winners, the live matchup, and
not-yet-played matchups as "to come" counts. Because winners are re-paired at random each
round, upcoming pairings genuinely don't exist yet — the graph never spoils what's next.

## Resuming and starting over

Your progress is saved in `localStorage` after every pick. If you reload or navigate away, you'll resume exactly where you left off.

- **Go back** (or <kbd>Backspace</kbd>): undoes your previous decision and returns to that
  matchup. Works across reloads and can be repeated to step back several picks.
- **Start over** (on the matchup or results screen): replays the tournament with the same film list.
- **Use a different file**: clears everything and returns to the upload screen.

## Deploying to GitHub Pages

This repo ships a GitHub Actions workflow (`.github/workflows/deploy.yml`) that runs the
test suite and then publishes the site automatically.

1. Push this repository to GitHub.
2. In the repository settings, go to **Pages** and set **Source** to **GitHub Actions**.
3. Every push to `main` (or `master`) runs the tests and deploys. The workflow can also be
   triggered manually from the **Actions** tab ("Run workflow"). The site is served at
   `https://<username>.github.io/<repo-name>/`.

The `.nojekyll` file tells GitHub Pages to skip Jekyll processing and serve the files as-is.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page app, four screens |
| `styles.css` | Letterboxd-themed dark styles, responsive |
| `app.js` | ZIP parser, CSV parser, tournament engine, UI |
| `fonts/` | Self-hosted Hanken Grotesk (SIL OFL) — no external font requests |
| `favicon.svg` | The three-dot mark used as the site icon |
| `og-image.png` | 1200×630 social-share / link-preview image |
| `manifest.webmanifest` | Web app manifest (name, icons, theme color) |
| `robots.txt` | Allows all crawlers, including AI assistants; links the sitemap |
| `sitemap.xml` | Sitemap for search engines |
| `llms.txt` | Plain-language summary for AI assistants |
| `.github/workflows/deploy.yml` | CI: runs tests, then deploys to GitHub Pages |
| `.nojekyll` | Prevents GitHub Pages from running Jekyll |
| `test_engine.js` | Node.js test suite (run with `node test_engine.js`) |

## SEO & discoverability

The page ships descriptive `<title>`/meta tags, Open Graph + Twitter card tags (with
`og-image.png`), and JSON-LD structured data (`WebApplication` + `FAQPage`) so search
engines and AI chatbots can understand and surface it. `robots.txt` explicitly welcomes AI
crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …), and `llms.txt` gives those
assistants a concise plain-text summary. **Note:** the absolute URLs in `index.html`,
`robots.txt`, `sitemap.xml`, and `manifest.webmanifest` assume the repo is named
`letterboxd-top-four` under user `dtsykunov`; if you use a different name or a custom domain,
find-and-replace `https://dtsykunov.github.io/letterboxd-top-four/`.
