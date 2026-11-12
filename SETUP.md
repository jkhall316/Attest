# Set up Attest, step by step

This guide takes you from nothing to a working Attest, whichever way you choose to run it. You do not need to be a programmer. If you can install an app, copy and paste, and follow a checklist, you can do this.

**How long it takes:** about 30 minutes the first time (Route A), or about an hour if you are downloading large AI models (Routes B and C). Most of that is waiting for downloads or for Cloudflare's website to finish something.

**If you get stuck,** every step ends with *"You should see…"* so you can tell whether it worked. Problems and fixes are listed in [If something goes wrong](#if-something-goes-wrong). You can also [open an issue](https://github.com/techjeffe/Attest/issues) and say which step you were on and what you saw.

---

## Contents

1. [Choose how to run Attest](#1-choose-how-to-run-attest)
2. [Before any route: terminal, Node, the code](#2-before-any-route-terminal-node-the-code)
3. [Route A: Cloudflare (reach it from any device)](#3-route-a-cloudflare-reach-it-from-any-device)
4. [Route B: on your Mac, nothing leaves it](#4-route-b-on-your-mac-nothing-leaves-it)
5. [Route C: on a Windows PC (or Linux), nothing leaves it](#5-route-c-on-a-windows-pc-or-linux-nothing-leaves-it)
6. [The Bluetooth pendant app (optional)](#6-the-bluetooth-pendant-app-optional)
7. [After setup: your first ten minutes](#7-after-setup-your-first-ten-minutes)
8. [Updating, backing up, and removing Attest](#8-updating-backing-up-and-removing-attest)
9. [If something goes wrong](#if-something-goes-wrong)

---

## 1. Choose how to run Attest

> ### Our recommendation: Route A (Cloudflare + OpenRouter)
>
> **If you are not sure, choose Route A and accept every default.** It is what Attest's author runs, it is the route that is simplest to keep working, and it is the only one you can open from your phone and that processes recordings while you sleep. It costs about **$10 a year for a domain plus roughly 10 cents per hour of recordings**, and it is the route this guide walks through most carefully.
>
> Choose Route B or C **only** if keeping your recordings off the internet matters more to you than convenience, *and* you have the right computer (see the table). They are good routes, just narrower ones.

Attest turns recordings into notes, tasks and a searchable memory. It needs two kinds of "AI brain": one that **turns speech into text**, and one that **reads the text and writes the notes**. The routes differ in *where those brains live*.

| | **Route A: Cloudflare** | **Route B: Mac only** | **Route C: Windows / Linux only** |
|---|---|---|---|
| In plain words | Attest lives on the internet in your own private Cloudflare account. You open it from any device. | Attest and its AI brains run on your Mac. | Attest and its AI brains run on your PC. |
| Open it from | Phone, laptop, anywhere | Only that Mac | Only that PC |
| Your recordings go to | Your Cloudflare account, and an AI company (OpenRouter or OpenAI) to be transcribed and summarized | Nowhere. They stay on your Mac. | Nowhere. They stay on your PC. |
| Running cost | About **$0.10 per hour recorded** (you pay the AI company; Cloudflare's part is free for normal use) | **$0** | **$0** |
| You need | A Cloudflare account, **a domain name** (about $10 a year), a bank card, and an AI key | An Apple Silicon Mac (M1 or newer, macOS 15+), ideally 16 GB of memory or more | A PC, ideally with a graphics card that has 16 GB or more. Windows 11 is the tested setup. |
| Background import (Pocket, Omi) while you sleep | Yes | No (your Mac must be on and running Attest) | No |
| Setup effort | Medium: a few website steps, then one command | Medium: install one app, download three models, then two commands | Higher: two helper programs, then two commands |

**Quick way to decide**

- *I want to open it on my phone, or have my recorder's notes waiting for me in the morning* → **Route A**.
- *Privacy matters most, I have a recent Mac, and I am fine using it only on that Mac* → **Route B**.
- *I have a Windows PC with a decent graphics card and the same privacy goal* → **Route C**.

You can change your mind later. Your recordings live in whichever place you chose; moving them between routes is not supported, so for a first try, pick the route you expect to keep.

**What does it cost?** Route A: you will add about $5 of credit to an AI account, which is roughly 50 hours of recordings. Cloudflare asks for a card to enable two of its features but does not charge for normal personal use. Routes B and C: nothing, apart from the electricity. See [Cost](README.md#cost) in the README for the detailed numbers.

---

## 2. Before any route: terminal, Node, the code

Every route uses these same three small steps. Do them once.

### 2.1 Open a terminal

A **terminal** is a window where you type a command and press Enter. That is all it is. You will paste a few lines into it during setup.

- **Mac:** press **Cmd + Space**, type `Terminal`, press Enter.
- **Windows:** click Start, type `PowerShell`, and open **Windows PowerShell** (or **Terminal**). Do not use "Command Prompt".
- **Linux:** open your Terminal app (often **Ctrl + Alt + T**).

**Tips:** to paste, use **Cmd + V** (Mac) or **right-click** / **Ctrl + V** (Windows). Run one command at a time and wait until you can type again before the next one. Lines starting with `#` are comments; you can skip them.

### 2.2 Install Node.js

Node.js is a free program that Attest's setup tools run on.

1. Go to [nodejs.org](https://nodejs.org/) and download the **LTS** version. It must be **version 22.12 or newer**.
2. Run the installer and accept the defaults.
3. **Close the terminal and open a new one** (this matters; the old one does not know about Node yet).
4. Check it worked by typing:

```
node -v
```

*You should see* something like `v22.12.0` or a higher number. If you see "command not found" or a number below 22, repeat from step 1 with a fresh terminal.

### 2.3 Get the Attest code

**Easiest, no extra software (works everywhere):**

1. Open [github.com/techjeffe/Attest](https://github.com/techjeffe/Attest).
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip it. You get a folder, for example `Attest-main`.
4. Move it somewhere short and easy, such as your home folder. **On Windows, keep the path short** (for example `C:\Attest`), because very long folder paths can break the local database.

**Or, if you already use Git:**

```
git clone https://github.com/techjeffe/Attest.git
```

### 2.4 Go to the folder and install its pieces

In your terminal, move into the folder. Replace the path with wherever you put it:

```
# Mac or Linux, if the folder is in your home folder:
cd ~/Attest-main

# Windows PowerShell, if it is at C:\Attest:
cd C:\Attest
```

Then run:

```
npm install
```

*You should see* a minute or two of activity, maybe some lines starting with "warn" (these are fine), ending with a line like `added 120 packages`. If it ends with a red "error", see [If something goes wrong](#if-something-goes-wrong).

**Windows only:** if PowerShell says *"npm.ps1 cannot be loaded because running scripts is disabled"*, run this once and then try again:

```
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

(It lets you run the standard tools that come with Node. It only affects your own account.)

You are now ready for your route. **Remember this folder**: every later command in this guide is run from inside it.

---

## 3. Route A: Cloudflare (reach it from any device)

**What you are building:** a private copy of Attest in your own Cloudflare account, at an address such as `https://attest.yourname.com`, protected by a login so only you can open it.

> **Why a domain?** To keep your recordings private, Attest only answers on an address you own and refuses all other addresses. Cloudflare then puts a login page in front of it. If you do not want to buy a domain, use Route B or C instead.

#### Pre-flight checklist: have all of this ready *before* you run any setup command

The setup program is quick, but it stops if a piece is missing. Do steps 3.1 to 3.6 first, tick each item, and then 3.7 to 3.9 take about five minutes.

- [ ] A Cloudflare account with two-step verification on (3.1)
- [ ] A domain showing **Active** in Cloudflare, and the address you will use, such as `attest.yourname.com` (3.2)
- [ ] **R2** enabled (3.3)
- [ ] **Zero Trust** set up on the Free plan (3.4)
- [ ] An **OpenRouter key** with $5 of credit, copied somewhere safe (3.5)
- [ ] A **Cloudflare API token** with the permissions listed in 3.6, copied somewhere safe, plus your **account id**
- [ ] Node installed and the Attest folder ready (Section 2)

**The recommended choices at every fork, in one place:** buy your domain at Cloudflare; use OpenRouter with the default models; make the API token so the login is created for you; answer `1` and press Enter for every default. Following these keeps you on the most-travelled road.

### 3.1 Create a Cloudflare account (free)

1. Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and sign up with your email.
2. Confirm your email (they send a link).
3. **Turn on two-step verification:** top right, your profile, **My Profile**, **Authentication**, and add an authenticator app. This protects everything you will store.

*You should see* the Cloudflare dashboard with your account name at the top left.

### 3.2 Get a domain on Cloudflare

You need a domain such as `yourname.com`. **We recommend buying a new one at Cloudflare** (Case 2): it is ready instantly, with no waiting for nameservers to change, which is the single most common place for a first-timer to stall. Pick the case that fits you:

**Case 1: you already own a domain.** In the dashboard click **Add a domain** (or **Onboard a domain**), type it in, choose the **Free** plan, and follow the instructions: Cloudflare gives you two "nameserver" addresses to enter at the company where you bought the domain. This can take from a few minutes to a day. You are done when the domain shows **Active**.

**Case 2: you need a domain (recommended).** Buy it at Cloudflare: in the dashboard go to **Domain Registration**, then **Register Domains**, search for a name, and buy it (typically about $10 a year for a `.com`). It becomes Active straight away.

**Case 3: you bought a domain elsewhere** and would rather keep it there. Add it to Cloudflare as in Case 1. (Tip: you can also use a cheap new domain just for Attest, bought as in Case 2, and leave your main one alone.)

Now **decide on an address for Attest**. It will be a *subdomain* of your domain, for example `attest.yourname.com`. It must not already exist in your domain's DNS list. If you have never made one called `attest`, you are fine. Write it down; you will type it in a moment.

*You should see* your domain listed as **Active** in the dashboard.

### 3.3 Turn on R2 (where recordings are stored)

1. In the dashboard sidebar open **R2 Object Storage**.
2. Click to enable it. It asks for a payment method. R2 has a generous free allowance, so normal personal use stays within it.

If you skip this, setup later stops with "Please enable R2 through the Cloudflare Dashboard" (error 10042).

### 3.4 Set up Zero Trust (the login page)

Zero Trust is Cloudflare's name for the product that puts a login in front of Attest.

1. In the dashboard sidebar open **Zero Trust**.
2. Choose a **team name**. Anything unique is fine (for example `smith-family`).
3. Choose the **Free** plan. Cloudflare asks for a card even for Free; you are not charged on the Free plan.

*You should see* the Zero Trust home page. You will not need to do anything else in it if you follow step 3.6.

### 3.5 Get an AI key

Attest needs an account with an AI provider to transcribe and summarize. The easiest and cheapest is **OpenRouter**, which uses one key for everything. (OpenAI also works; see the note below.)

**OpenRouter (recommended):**

1. Go to [openrouter.ai](https://openrouter.ai/) and sign up.
2. Open **Credits** and add **$5** (a card is required). This is prepaid, so you can never be billed more than you add.
3. Open **Keys** ([openrouter.ai/keys](https://openrouter.ai/keys)), click **Create Key**, give it a name such as `attest`, and **copy the key** (it starts with `sk-or-`). You can only see it once.
4. Paste it somewhere safe for now, such as a password manager. **Treat it like a password**: anyone with it can spend your credit.

**OpenAI instead:** sign up at [platform.openai.com](https://platform.openai.com/), add billing, and create a key under **API keys**. It works but costs about three times as much per hour as the recommended OpenRouter route.

### 3.6 Make a Cloudflare token so Attest can set up the login for you

**Do this step.** It lets the setup program create the login page for you, which is otherwise a dozen dashboard clicks where one wrong box leaves you locked out. (If you truly prefer clicking through the dashboard, skip to [3.7](#37-sign-in-to-cloudflare-from-the-terminal) and use [Doing the login by hand](#doing-the-login-by-hand-advanced-fallback) at the end of this route.)

1. Open [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) and click **Create Token**, then **Create Custom Token**.
2. Give it a name, such as `attest setup`.
3. Under **Permissions**, add these (all under **Account**):
   - **Access: Apps and Policies** with **Edit**
   - **Access: Organizations, Identity Providers, and Groups** with **Edit**
   - Only if you will use the Bluetooth pendant app: **Access: Service Tokens** with **Edit**
4. Under **Account Resources** choose **Include**, then your account.
5. Click **Continue to summary**, then **Create Token**, and **copy the token**.

You will paste it into the setup program once. It is never saved. You should delete it afterwards (step 3.10).

You will also be asked for your **account id**: open any domain in the dashboard, and it is in the right-hand column of the Overview page. The setup program often finds it by itself.

### 3.7 Sign in to Cloudflare from the terminal

In your terminal, inside the Attest folder (see [2.4](#24-go-to-the-folder-and-install-its-pieces)):

```
npx wrangler login
```

Your web browser opens. Click **Allow**.

*You should see* "Successfully logged in" in the terminal. (If a browser window does not open, copy the web address shown in the terminal into your browser yourself.)

### 3.8 Run the setup program

```
npm run deploy
```

The first time, it asks you a series of questions. Here is each one, and what to type:

| It asks | What to type |
|---|---|
| **Where should Attest run? Choose 1 or 2** | `1` (Cloudflare). Press Enter. |
| **Hostname for Attest** | The address you chose in 3.2, for example `attest.yourname.com`. Do not add `https://`. |
| **Your email** | The email you will sign in with. Lowercase. This email "owns" every recording. |
| **AI provider** | Press **Enter** to accept `openrouter` (or type `openai` if you chose OpenAI). |
| **OpenRouter API key** | Paste the key from 3.5 and press Enter. **You will not see it as you type or paste; that is normal.** |
| **Chat model / transcription model** | Press **Enter** at each to accept the recommended defaults (`openai/gpt-oss-20b` and `microsoft/mai-transcribe-2`). |
| **Also offer in the dropdown** | Press Enter (it means "none"). |
| **Which of these do you record with?** (a list of yes/no questions) | `y` for **Record or upload in the Attest app itself**. For Pocket, Omi, or the pendant, answer `y` only if you own one. You can change this later in Settings. If you say yes to Pocket or Omi it asks for their API key; you can press Enter to skip and add it later. |
| **Create the Cloudflare Access login automatically?** | `y`. Paste your **account id** and the **token** from 3.6 when asked. (Only if you skipped 3.6, answer `n` and do [Doing the login by hand](#doing-the-login-by-hand-advanced-fallback).) |

Then it works for a minute or two, creating your private storage and database and putting Attest online. It prints what it is doing as it goes.

*You should see* a line ending with something like:

```
Done. Open https://attest.yourname.com, enter you@example.com, and use the emailed code.
```

If it says "Zero Trust is not set up yet", do [3.4](#34-set-up-zero-trust-the-login-page) and run `npm run deploy` again. It is safe to run again at any time; it picks up where it left off.

### 3.9 Open Attest and sign in

1. Open the address you chose (for example `https://attest.yourname.com`). Use a normal browser window.
2. You land on a **Cloudflare login page**, not on Attest yet. That is correct: it is the lock on the door.
3. Type the email you gave the setup program and click **Send login code**.
4. Check your inbox (and spam) for a 6-digit code from `noreply@notify.cloudflare.com`. It works once and expires after 10 minutes. Enter it.

*You should see* Attest's **Today** screen.

**First test:** click **Record**, say a sentence or two, and click again to stop. Wait a few seconds. *You should see* the recording appear in the left list, change from "Processing" to "Ready", and open to show a transcript and a summary. If it shows "Failed", see [If something goes wrong](#if-something-goes-wrong).

### 3.10 Clean up

If you made an API token in 3.6, delete it now at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens). Setup is finished and it is no longer needed.

### 3.11 Use it from your phone

Open your Attest address in your phone's browser and sign in with the emailed code. Then add it to your home screen so it works like an app:

- **iPhone (Safari):** tap the **Share** button, then **Add to Home Screen**.
- **Android (Chrome):** tap the **⋮** menu, then **Add to Home screen** (or **Install app**).

The first time you record, your phone asks permission to use the microphone. Allow it.

### Doing the login by hand (advanced fallback)

Only if you answered `n` to creating the login automatically. Most people should not need this section. This sets up the same lock on the door through the dashboard:

1. **Zero Trust → Integrations → Identity providers.** If **One-time PIN** is not listed, click **Add new identity provider** and choose **One-time PIN**. (This is what lets you log in with an emailed code, with no Google or GitHub account needed.)
2. **Zero Trust → Access controls → Applications → Create new application → Self-hosted and private.**
3. Name it `Attest`. Click **Add public hostname**, choose your domain, and enter your subdomain so the full address matches **exactly** what you gave the setup program. No wildcards.
4. Under **Access policies**, create a policy: **Action = Allow**, **Include → Emails**, and your email (exactly as you typed it in setup).
5. Make sure **One-time PIN** is the enabled login method.
6. Set **Session Duration** to something like 1 month, and click **Create**.

Cloudflare's menu names move around occasionally; look for the same idea nearby. Until this is done, your address shows an error that says `401`: that is Attest locked and waiting for its login, not broken.

### What Route A keeps running without you

Every 15 minutes Attest wakes by itself, imports new Pocket and Omi recordings (if you set those up), processes them, and builds its memory of older recordings. That is why your notes can be waiting in the morning.

---

## 4. Route B: on your Mac, nothing leaves it

**What you are building:** Attest running on your Mac, talking to AI models that also run on your Mac. No account, no internet needed once the models are downloaded, no fees.

**Requirements:** an **Apple Silicon Mac** (M1, M2, M3, M4 or newer) with **macOS 15 or newer**. About 16 GB of memory is comfortable; about 15 GB of free disk space is needed for the models. Intel Macs are not supported by the model software.

### 4.1 Install oMLX (the model server)

oMLX is a free app that runs AI models on Apple chips.

1. Go to [github.com/jundot/omlx](https://github.com/jundot/omlx) (or [omlx.ai](https://omlx.ai)) and follow its install instructions for macOS.
2. Start oMLX. It runs a small server on your Mac.
3. In oMLX's settings, **set an API key** (any password you choose). Setup will ask for it. Write it down.

### 4.2 Download three models inside oMLX

In oMLX's admin page open **Models**, search Hugging Face, and download these three (each does a different job). Names must match exactly:

| Job | Download this | Size |
|---|---|---|
| Writing notes and answering questions | `mlx-community/gpt-oss-20b-MXFP4-Q8` | about 12 GB |
| Turning speech into text | `mlx-community/whisper-large-v3-turbo-asr-fp16` | about 1.6 GB |
| Searching by meaning | `mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ` | under 1 GB |

**Less memory?** If your Mac has 16 GB or less and things feel slow, use `mlx-community/Qwen3.5-9B-MLX-4bit` (about 5 GB) for the first one instead. Summaries will be a little less polished.

**Important:** for transcription, pick a model with **`-asr`** in its name. Plain Whisper models without it fail to load.

Downloading takes a while on a normal connection. This is the slow part of Route B. Wait until all three show as downloaded.

### 4.3 Connect Attest to oMLX

In your terminal, in the Attest folder:

```
npm run setup:local
```

It walks you through these questions:

| It asks | What to do |
|---|---|
| **Have the models you want downloaded, and the server running?** | `y` if you finished 4.1 and 4.2. |
| *(It finds your oMLX automatically.)* **Server address** | Press Enter to accept what it found. |
| **API key for that server** | Type the key from 4.1 (you will not see it as you type). |
| **Which model for each job** (three short lists) | Press Enter to accept the one marked `<- recommended`. |
| **Context window your chat model runs with, in tokens** | Press Enter for `32768`. |

Then it **tests each model** and prints lines like `chat: ✓ answers in JSON`, `embeddings: ✓ 1024-dimensional` and `transcription: ✓ accepted an upload`.

*You should see* all three with a ✓ and a line saying it wrote `.dev.vars`. If one shows ✗, the message beside it says what to fix; see [If something goes wrong](#if-something-goes-wrong). You can re-run `npm run setup:local` any time.

### 4.4 Start Attest

```
npm run local
```

Wait until you see `Ready on http://localhost:8787`. Then open **[http://localhost:8787](http://localhost:8787)** in your browser.

(You will see a warning about "Scheduled Workers". It is harmless.)

*You should see* Attest's **Today** screen. Record a short test: click **Record**, speak, click again. Allow the microphone if your browser asks. After a short wait the recording becomes "Ready".

### 4.5 Living with it day to day

- **Starting it again:** each time you restart your Mac or close the terminal, open a terminal, `cd` into the Attest folder, and run `npm run local` again. Leave that terminal window open while you use Attest.
- **oMLX must be running too.** Start it before Attest.
- **Keep the Mac awake** if you want long recordings to finish processing. (System Settings → Battery/Lock Screen.)
- **Back up `.wrangler/state`** inside the Attest folder. It holds all your recordings and notes. It is your only copy.
- **Checking health:** `npm run local:check` re-tests everything and says what to fix.

More detail on speakers, memory and settings: [Run it locally on a Mac](README.md#run-it-locally-on-a-mac-omlx).

---

## 5. Route C: on a Windows PC (or Linux), nothing leaves it

**What you are building:** Attest running on your PC, using AI models that also run on your PC. No account and no fees.

**Honest status:** this has been tested end to end on **Windows 11 with an NVIDIA graphics card** using **Ollama** (for the writing and search brains) and **Speaches** (for speech-to-text). Linux, LM Studio, and whisper.cpp are expected to work but have not been tried. Setting up Cloudflare (Route A) *from* Windows has also not been tried yet, so Windows is tested for Route C.

**Requirements:** A graphics card with **16 GB of memory or more** runs the recommended models comfortably. With less, use a smaller model (see 5.2); summaries will be less polished. About 30 GB of free disk space. **Docker Desktop** (for the speech program). The speech program is tested with an NVIDIA card; a computer without one is untested.

### 5.1 Do the shared steps first

Complete [Section 2](#2-before-any-route-terminal-node-the-code) (Node and the code). Keep the folder path short, such as `C:\Attest`.

### 5.2 Install Ollama and download the models

Ollama runs the writing and search models.

1. Download and install Ollama from [ollama.com](https://ollama.com/). It starts in the background.
2. In PowerShell, download the two models:

```
ollama pull gpt-oss:20b
ollama pull qwen3-embedding:0.6b
```

(Smaller graphics card? Use a smaller chat model, such as `ollama pull qwen3:8b`, and expect plainer summaries.)

3. **Give the chat model room to read long recordings.** Ollama's default is too small for a long conversation. Set this once:
   1. Press **Start**, type `environment variables`, open **Edit the system environment variables**, then **Environment Variables…**.
   2. Under **User variables**, click **New…**. Name: `OLLAMA_CONTEXT_LENGTH`. Value: `32768`. Click OK.
   3. **Quit Ollama completely** (right-click its icon in the system tray, **Quit**) and start it again.

*Using LM Studio instead?* It also works in principle: download `openai/gpt-oss-20b` and an embedding model, start its server on the **Developer** tab, and load the chat model with a context of 32k tokens or more. This route is untested.

### 5.3 Install Docker Desktop and the speech program (Speaches)

Ollama does not transcribe speech, so a second helper does that.

1. Install **Docker Desktop** from [docker.com](https://www.docker.com/products/docker-desktop/) and start it. Accept its prompts (it may ask to restart your PC).
2. In PowerShell, start the speech program. Paste this whole block:

```
docker run -d --gpus all --restart unless-stopped -p 8000:8000 --name speaches `
  -v speaches-hf:/home/ubuntu/.cache/huggingface/hub -e WHISPER__COMPUTE_TYPE=float16 `
  ghcr.io/speaches-ai/speaches:latest-cuda
```

3. Download its speech model (this is a one-time download of a couple of GB):

```
Invoke-RestMethod -Method Post http://localhost:8000/v1/models/deepdml/faster-whisper-large-v3-turbo-ct2
```

*You should see* a response without an error. Docker Desktop shows a running container named `speaches`. It restarts by itself after a reboot as long as Docker Desktop is running.

> Do not turn on Speaches' "batched mode". It needs an extra feature that Attest does not use and causes errors.

### 5.4 Connect Attest to your models

In PowerShell, inside the Attest folder:

```
npm run setup:local
```

| It asks | What to do |
|---|---|
| **Have the models you want downloaded, and the server running?** | `y` |
| *(It finds Ollama automatically.)* **Server address** | Press Enter. |
| **API key for that server** | Ollama has none. Type anything (for example `x`) and press Enter. |
| **Which model for each job** | Press Enter to accept the one marked `<- recommended`. |
| **No transcription model found on that server. Use a different server for transcription?** | `y`, then for the address press Enter to accept `http://localhost:8000/v1`, key: `x`, and press Enter for the suggested model. |
| **Context window** | Press Enter for `32768`. |

It then tests each part and shows a ✓ for each. Next, run the full test with a real voice. You need a short recording of someone speaking, saved as a `.wav` file (for example, record yourself in Voice Recorder and convert it, or download any short speech sample):

```
npm run local:check -- --audio speech.wav
```

*You should see* every line with a ✓, including one that confirms the transcription returns timestamps. Attest needs those timestamps to tell speakers apart.

### 5.5 Start Attest

```
npm run local
```

Open **[http://localhost:8787](http://localhost:8787)**. Record a short test. Allow the microphone when asked.

A 48-second two-person recording was tested and came back fully processed in about 80 seconds on an RTX 5090. Expect it to be slower on weaker cards.

**One known limit:** when two people speak very close together, an action item can occasionally be credited to the wrong person. Check names before relying on them.

### 5.6 Day to day

- Start in this order: Docker Desktop and Ollama running, then open PowerShell in the Attest folder and run `npm run local`. Keep that window open while you use Attest.
- Your recordings and notes live in `.wrangler\state` in the Attest folder. **Back it up.**
- If you ever see `SQLITE_CANTOPEN`, your folder path is too long. Move Attest to something short like `C:\Attest`, or run `npm run local -- --persist-to C:\attest-state`.

### 5.7 Linux

The steps are the same, with these swaps: install Node from nodejs.org or your package manager, install Ollama with its Linux installer from ollama.com, run the same `docker run` command (on one line, without the backticks) and the same `curl` download in place of `Invoke-RestMethod`, and set `OLLAMA_CONTEXT_LENGTH=32768` in the Ollama service's environment. This has not been tested; please report what you find.

More detail: [Run it locally on Windows or Linux](README.md#run-it-locally-on-windows-or-linux).

---

## 6. The Bluetooth pendant app (optional)

If you wear a Limitless pendant, a separate Mac or iPhone app can collect its audio over Bluetooth and send it to Attest. **This is the one part of Attest that is not point-and-click**: the app is built from source with Apple's developer tools (Xcode), and putting it on your own iPhone needs an Apple developer account. If that sounds like too much, use Attest's built-in recorder, or Omi (which imports the pendant's transcripts) instead.

If you do want it, the instructions are in [apple/README.md](apple/README.md). It works with Route A (it signs in with a special device key that the Cloudflare setup can create for you, which is why 3.6 offers the extra "Service Tokens" permission) and needs Attest to be reachable on the internet.

---

## 7. After setup: your first ten minutes

Whichever route you chose, do these once. They make everything after better.

1. **Tell Attest who you are.** Click the button at the top right (it says *Speaking as*). Pick your name or type it. Now "I" and "me" in your daily brief mean you, and your own to-dos sort to the top.
2. **Choose how you record.** Click the **gear icon** (top right) and tick the ways you capture conversations: the app itself, Pocket, Omi, a pendant. Add an API key for Pocket or Omi there if you use them.
3. **Record something real**, even two minutes. Open it and look at the summary, the action items, and the speakers.
4. **Name your speakers.** On a recording, click an "Unknown" speaker chip and give it a name. Attest remembers voices you confirm, so future recordings name people automatically.
5. **Open Today.** It starts empty and fills in as you record. Your first useful daily brief appears after a few recordings.
6. **(Optional) Pick an area.** The dropdown at the top (All areas, Work, Personal, Health, Learning) lets you look at one part of your life at a time.

---

## 8. Updating, backing up, and removing Attest

### Updating to a newer version

New versions keep your recordings and settings. In a terminal, in your Attest folder:

- **If you installed with Git:**
  ```
  git pull
  npm install
  ```
- **If you downloaded the ZIP:** download the new ZIP, unzip it, then **copy these two files from your old folder into the new one** (if they exist): `wrangler.local.toml` (Route A) and `.dev.vars` (Routes B and C). Then in the new folder run `npm install`. For Routes B and C also copy the whole `.wrangler` folder across, because it holds your recordings.

Then apply it:

- **Route A:** `npm run deploy`
- **Routes B and C:** `npm run local`

### Backing up

- **Route A:** your recordings are in your Cloudflare account (R2 storage and a D1 database). You can export everything from the app with **Export .zip** in the top bar.
- **Routes B and C:** copy the `.wrangler` folder (inside the Attest folder) somewhere safe regularly. It is your only copy. **Export .zip** in the app also gives you a readable copy of your notes.

### Removing Attest

- **Routes B and C:** quit Attest and delete the Attest folder. Uninstall oMLX or Ollama and Docker if you no longer want them.
- **Route A:** in the Cloudflare dashboard delete, in this order: the **Zero Trust → Access → Applications → Attest** application; **Workers & Pages → attest**; **Storage & Databases → D1 →** the Attest database; **R2 Object Storage →** the Attest bucket (empty it first); and the `attest` record under your domain's **DNS**. Cancel your OpenRouter key at [openrouter.ai/keys](https://openrouter.ai/keys).

---

## If something goes wrong

Find what you saw, and try the fix beside it.

**Before setup (terminal and installs)**

| What you see | What it means and what to do |
|---|---|
| `node: command not found` / `npm: command not found` | Node is not installed yet, or the terminal was open when you installed it. Install it ([2.2](#22-install-nodejs)), then **close and reopen the terminal**. |
| `node -v` shows a number below 22 | Install the latest **LTS** from nodejs.org, reopen the terminal, and check again. |
| (Windows) `npm.ps1 cannot be loaded because running scripts is disabled` | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, then retry. |
| `npm install` ends with a red error about a "path" or "ENOENT" | You are probably not inside the Attest folder. Run `cd` to the folder (see [2.4](#24-go-to-the-folder-and-install-its-pieces)) and try again. On Windows, a very long folder path can also cause it; move the folder to `C:\Attest`. |
| `npm run deploy` says "Missing script" | Same cause: you are not in the Attest folder. |

**Route A (Cloudflare)**

| What you see | What it means and what to do |
|---|---|
| `npx wrangler login` opens no browser | Copy the long address it prints into your browser by hand. |
| Deploy stops: "Please enable R2 through the Cloudflare Dashboard" (10042) | Do [3.3](#33-turn-on-r2-where-recordings-are-stored), then run `npm run deploy` again. |
| "Zero Trust is not set up yet" | Do [3.4](#34-set-up-zero-trust-the-login-page), then run `npm run deploy` again. |
| Setup fails on Access with **403** | Your token is missing a permission or belongs to a different account. Re-check [3.6](#36-make-a-cloudflare-token-so-attest-can-set-up-the-login-for-you) and make a new one. |
| Deploy fails on the custom domain | The address you chose already has a DNS record, or the domain is not yet **Active**. Pick a different subdomain (for example `notes.yourname.com`) and run `npm run setup` to change the hostname. |
| Your address shows an error with `401` | The login is not in place yet. Finish [Doing the login by hand](#doing-the-login-by-hand-advanced-fallback), or re-run `npm run setup` and answer `y` to creating it. |
| The `….workers.dev` address gives 404 | Expected. Attest deliberately only answers on your own domain. |
| The login code never arrives | Check spam, and that you typed exactly the email set in the Access policy. Cloudflare says "code sent" even for the wrong email, on purpose. Some mail providers block `notify.cloudflare.com`; allow it. |
| "This One-Time PIN has already been used" | An email scanner opened the link first. Ask for a new code. |
| A recording shows **Failed** with a transcription error | The AI key is missing, wrong, or out of credit. Click the **gear icon** and re-enter it, and check your OpenRouter balance. |
| Recordings imported in the background never appear | The `OWNER_EMAIL` does not match the email you log in with. Re-run `npm run setup` and enter the same email. |

**Routes B and C (on your computer)**

| What you see | What it means and what to do |
|---|---|
| `setup:local` says it could not find a server | The model program is not running. Start oMLX (Mac) or Ollama (Windows) and run it again. |
| A model shows ✗ in `setup:local` or `local:check` | The message beside it says why. The most common: the model is not downloaded yet, or for transcription it lacks `-asr` in its name (Mac). |
| Transcription error: "missing the HuggingFace processor / feature-extractor configuration" | You downloaded a Whisper model that cannot load. Download the `-asr` version in oMLX. `npm run local:check` prints the exact fix. |
| `summarize returned invalid JSON` | The writing model is too small or too slow. Use the recommended one (`gpt-oss`), or a larger one. |
| Summaries are shallow on long recordings | The model's reading window is too small. Raise Ollama's `OLLAMA_CONTEXT_LENGTH` (Windows) or the model's context in oMLX, and re-run `setup:local` with the new number. |
| Nothing at `localhost:8787` | `npm run local` is not running, or its terminal was closed. Run it again and wait for `Ready on http://localhost:8787`. |
| "Port 8787 is already in use" | A previous copy is still running. Close the old terminal window, or restart your computer. |
| The microphone does nothing | Your browser blocked it. Click the padlock beside the address, set **Microphone** to **Allow**, and reload. |
| (Windows) `SQLITE_CANTOPEN` | The folder path is too long. Move Attest to `C:\Attest`, or run `npm run local -- --persist-to C:\attest-state`. |
| Speakers are not separated | Your transcription program did not return timestamps. Run `npm run local:check -- --audio speech.wav`; it says so if so. |

**Anything else**

Run `npm run local:check` (Routes B and C) for a plain health report, and read the longer [Troubleshooting](README.md#troubleshooting) table in the README. If you are still stuck, [open an issue](https://github.com/techjeffe/Attest/issues) with: which route you chose, the step number you were on, and what you saw (a screenshot or the last lines of the terminal are perfect). **Never paste an API key or token into an issue.**
