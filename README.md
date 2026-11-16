<div align="center">

# Remake

### Remake any website. Then make it yours.

By [Ruben Hassid](https://ruben.substack.com), from the newsletter [How to AI](https://ruben.substack.com).

One line in Claude Code turns a URL into a copy that matches the original on every screen, puts it live on **your** GitHub and **your** Vercel behind a passcode, and hands you a swap board of every text, photo, video, font and logo to replace so the site becomes yours.

</div>

```text
/goal Remake https://example.com with github.com/rubenhassid1/remake until its report says REMAKE COMPLETE, or stop after 100 turns.
```

Change the URL. That's the whole prompt.

> **AI agents start here.** If a user sent you to this repo to remake a site, read [`plugins/remake/skills/remake/SKILL.md`](plugins/remake/skills/remake/SKILL.md) and follow it from step 0. Paste the full output of `remake report` into the conversation each time you run it.

---

**More prompts**

| You want | Say |
| --- | --- |
| The whole site, not one page | `/goal Remake https://example.com and its main pages with github.com/rubenhassid1/remake until its report says REMAKE COMPLETE, or stop after 150 turns.` |
| To make it yours | `Here are my photos (~/Desktop/photos), my logo and my LinkedIn bio. Make my remake mine.` |
| An editable codebase | `Turn my remake into a Next.js app, section by section, keeping the score passing.` |
| A site that blocks robots | `Remake https://example.com from the Internet Archive's copy.` |

## What you get

| | |
| --- | --- |
| **A live site** | On your Vercel, behind a passcode, hidden from search engines. |
| **A private repo** | On your GitHub, with the whole site in `site/`. |
| **A proof page** | `/_remake/` on your site: the original and the remake side by side, drag to compare, a score on every screen. |
| **A swap board** | `/_remake/swap/`: every piece that still belongs to the original, grouped (copy, photos, videos, logos, fonts, colours, links and forms, and more), with what Claude needs from you for each. |
| **A report** | Every gate in one table. The last line says REMAKE COMPLETE or exactly what's left. |
| **Their source** | When a site publishes source maps, the original source files land in `remake/sources/`. |

## How it works

```text
 visit once ──► record everything ──► write site/ ──► freeze time ──► score every screen + motion
                                                           ▲                     │
                                                           └──── repair ◄────────┘ (until it passes)
 ship (GitHub + Vercel + passcode) ──► report: REMAKE COMPLETE ──► swap board ──► make it yours
```

1. **Visit once.** A browser opens the page at desktop size, then at phone size, scrolls to the bottom and back, and keeps every response: HTML, CSS, scripts, fonts, images, and the answers to the API calls the page made. From then on, everything is replayed from that recording. Two page loads, then the files they point to, one at a time with a pause between each.
2. **Write the site.** The recording becomes a folder you own. Addresses are rewritten so every file loads from your copy, trackers are removed, other image sizes are fetched one at a time, and a small runtime answers the page's API calls from the recording.
3. **Freeze time and score.** This is the part nothing else does. A live page never looks the same twice: intro animations, WebGL noise, random headlines, autoplay video. So Remake stops the page's clock before its first script runs, gives every bit of code that asks for a random number the same answers, holds every video on its first frame, puts the browser's own animations (`element.animate`) on that same paused clock, and moves time forward itself in exact steps. Load the same page twice this way and you get the same pixels twice, so the remake can be measured against the original to the pixel: every screen at desktop and phone (up to 40 per page), plus 24 frames of scrolling motion. Whatever still changes between two loads of the original (a live map, a clock) is left out of the score and shown in blue.
4. **Repair.** Claude reads the diff images, opens the remake, fetches what's missing and fixes what's broken, until every screen passes: 98% of stable pixels per screen, 95% per motion frame, page heights within 4 px.
5. **Ship.** Private GitHub repo, Vercel deploy, passcode gate, then a check from outside that the gate holds.
6. **Make it yours.** Every slot of the original goes into `remake/content.json` with where it lives in the files. Send Claude your photos, your About page, your logo and links; it fills the slots in your voice, at the same length so the layout holds, crops your photos to every size the site uses, and serves a free look-alike font under the original font's name so no CSS changes.

## What's new here

Other cloners redraw a site from screenshots and then eyeball it. Remake does six things they don't:

- **It copies; it doesn't redraw.** The original's own markup, styles and scripts run in your copy, so smooth scroll, text effects, WebGL and sliders come with it.
- **It freezes time to measure.** Paused clock (browser animations included), seeded randomness per line of code, held video, and a noise mask from two loads of the original. A score you can trust on animated, WebGL-heavy sites.
- **It scores motion,** not only still screens.
- **It ends live and private,** on your GitHub and Vercel, with the gate checked.
- **It makes the site yours,** with a swap board and an `apply` that keeps the layout intact.
- **It never feeds their photos to a generator.** Remake measures every picture (shape, colours, light), Claude writes what yours should show, and Codex on your ChatGPT plan generates it in the same frame and mood. No ChatGPT? Free public-domain stock, then generated art. Every image is credited.

It's built for Claude Code's `/goal`: the `/goal` judge only reads the conversation, so the engine prints its evidence and a single finish line Claude can't reach without passing every gate.

## Three ways to run it

**1. Just the prompt** (above). Claude reads this repo, installs the engine into `~/.remake` and runs it.

**2. As a Claude Code plugin.**

```text
/plugin marketplace add rubenhassid1/remake
/plugin install remake@remake
```

Then `/remake https://example.com`, or keep it running until it's done with `/goal Remake https://example.com until its report says REMAKE COMPLETE, or stop after 100 turns.`

**3. As a command-line tool.**

```bash
npm install -g github:rubenhassid1/remake
remake doctor --fix
remake init https://example.com && cd ~/remakes/example-com
remake capture && remake score
```

| Command | What it does |
| --- | --- |
| `remake doctor [--fix]` | Checks Node, git, GitHub and Vercel or Railway sign-in and Chromium; installs what it can. |
| `remake status` | Where the project stands and the next command to run. |
| `remake init <url> [--pages N] [--dir path]` | Starts a project in `~/remakes/<site>`. `--pages 6` remakes the home page plus up to 5 pages from its navigation. |
| `remake capture [--archive [timestamp]] [--fresh]` | Visits once, writes the site into `site/`. `--archive` rebuilds from the Internet Archive's copy; `--fresh` records again. |
| `remake serve [--port 4310]` | Runs the remake locally. Every 404 is logged. |
| `remake fetch --missing` / `remake fetch <url…>` | Fetches what the remake asked for and didn't have (or the addresses you give), one file at a time. |
| `remake score [--fresh] [--page /path] [--viewport desktop\|phone] [--no-motion]` | Freezes time, scores every screen and the motion, prints PASS or what's off. |
| `remake accept "<screen>" --reason "…"` | Accepts one difference that can't be fixed (90% or more), with the reason on record. |
| `remake slots` | Lists every piece that belongs to the original in `remake/content.json`. |
| `remake images` / `remake images --make` | Measures every picture that still belongs to the original, then makes new ones: Codex on your ChatGPT plan, an API key, free stock or generated art. |
| `remake apply [--force]` | Puts your swaps into the site. |
| `remake board` | Builds the proof page, the swap board and `MAKE-IT-YOURS.md`. |
| `remake ship [--name repo] [--passcode CODE] [--scope team] [--host vercel\|railway] [--workspace W]` | Private GitHub repo, Vercel (default) or Railway deploy behind a passcode, gate check. Running it again keeps the passcode and the host. |
| `remake report` | Every gate in one table, ending in REMAKE COMPLETE or what's left. |

You need Claude Code, Node 20 or newer, git, the GitHub CLI and free GitHub and Vercel accounts (`remake doctor --fix` installs the GitHub and Vercel command-line tools; on a Mac without Homebrew, install the GitHub CLI from cli.github.com). The first run downloads Chromium for Playwright (about 150 MB). If `npm install -g` fails with a permissions error, run the tool as `node ~/.remake/engine/bin/remake.mjs` instead. Signing in to GitHub and Vercel is one click each in your browser; Claude starts both.

**Railway instead of Vercel.** Install the Railway CLI (`brew install railway`), run `railway login`, then `remake ship --host railway`. Remake adds `server.mjs` (a static server for `site/` with the same passcode gate), sets `REMAKE_PASSCODE` on a Railway service called `web`, deploys, generates a `*.up.railway.app` domain and checks the gate. Later `remake ship` runs reuse the same project, service and passcode.

## What it won't do

- **Copy sign-in, checkout or banking pages.** A copy of those is a phishing kit. The engine stops when it sees password or card fields.
- **Get around bot walls.** No proxies, stealth browsers, fake identities or CAPTCHA solvers. Remake's browser says who it is in its user agent. When a site blocks the visit or stops answering, Remake stops asking it and says so. Rebuilding from the Internet Archive's public copy is your choice (`remake capture --archive`), never automatic.
- **Publish someone else's site.** Every remake starts private: passcode on, hidden from search engines, repo private. The swap board shows what still belongs to the original; until it reads 100%, keep it that way.

Good uses: learning how a site is built, moving your own site off an old platform, or starting a site of your own. The original's words, photos, logos, fonts and code belong to its owner.

## FAQ

**How long does it take?** The engine's own steps take minutes. The repair loop is where the time goes: a simple marketing page can pass on the first score; a WebGL agency site can take Claude hours.

**What does 98% mean?** Of the pixels that are stable in the original (the same across two loads), at least 98% are within about 10% of the original's colour on every screen. The proof page shows every screen so you can judge for yourself.

**Does it hammer the site?** No. One visit at desktop size and one at phone size, the way a person would load the page. Everything after that is replayed from the recording, extra files are fetched one at a time with a pause between each, and if a host stops answering Remake stops asking it.

**Does it copy the backend?** No. Logins, databases, payments and forms that send email stay with the original. API answers the page loaded during the visit are replayed so pages that draw from an API still look right. Forms are held back until you give them an address.

**What doesn't work yet?** Pages behind a login, sites that block automated visits, live data that changes every second, WebSocket apps and checkout flows (on purpose).

## Credits

Ideas, not code, from projects that came first: [ai-website-cloner-template](https://github.com/JCodesMore/ai-website-cloner-template) (observe before you build), [dittu](https://github.com/Manish-Tamang/dittu) (copy what the browser rendered, keep the original CSS), [Perfect-Web-Clone](https://github.com/ericshang98/Perfect-Web-Clone) (pass/fail gates), [claude-skill-web-clone](https://github.com/Jane-xiaoer/claude-skill-web-clone) (find the source first, keep the look and swap the content) and [rea](https://github.com/morluto/rea) (source maps, evidence for every finding).

MIT licence. How it works in detail: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Who made this

Remake is made by Ruben Hassid, who writes [How to AI](https://ruben.substack.com), a newsletter that shows you, click by click, how to use AI at work. Every issue tests a tool on screen and gives away what it builds, like this one.

[Substack](https://ruben.substack.com) · [LinkedIn](https://www.linkedin.com/in/ruben-hassid) · [X](https://x.com/rubenhassid)

If Remake saved you a week, [subscribe](https://ruben.substack.com) for the next tool.
