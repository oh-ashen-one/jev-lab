# Jev Lab

A chess game driven by [TypeSafe Jev](https://docs.typesafe.ai) — a **System One
model** that does not write text. You send it a state and a set of typed
questions; it returns a choice, a score, or a probability. No prose, no parsing,
output tokens are free.

This lab exists to answer one question honestly: **what does a decision model
actually look like inside a running game?**

```
python3 server.py        # then open http://127.0.0.1:8770
```

The server holds the API key server-side and proxies every call. The browser
never sees it.

## The thing to understand first

**Jev cannot see.** Images, audio and video are not supported — TypeSafe says so
explicitly, and their own Doom demo notes it runs "on structured state as a data
structure with text, not on images."

So the demo needs a *translator*: code that turns the world into numbers. The
translator is not a detail. It is most of the result.

## The game

### Chess — code owns tactics, Jev owns judgment

Jev is a decision model, not a search engine. It cannot look ahead. So the
division of labour is explicit and visible in the UI:

- **code** generates legal moves and can filter to the tactically sane ones, so
  Jev can never see an illegal move or hang a piece by arithmetic slip
- **Jev** chooses among the survivors, and expresses a *plan* — which is where a
  decision model is genuinely strong

Its probability distribution is painted onto the board as a heatmap, so you can
see the shape of its thinking before the move lands. Each side has its own
**intent** selector — solid / aggressive / defensive / greedy / chaotic — so the
same model can be given two different personalities and watched diverging.

Press **▶ jev vs jev** and it plays itself end to end: each side's tag lights up
while its call is in flight, and a narration strip reports every move in plain
terms — the move number, the pick, how much of its probability mass it spent,
its stated plan, and its king-worry score. Pause any time to play white
yourself. Turn off the candidate screen and you can watch it play badly in a
legible way.

## What the panel shows

Every panel is a live view of internals, not decoration: the full probability
distribution for each question, the calibrated confidence, whether a gated answer
was an abstention, the exact state payload that went over the wire, model
version, per-call latency split into model vs network, and a running cost total.

Note `confidence` is a **separate quantity** from the winning option's
probability — it is common to see `conf 0.12` over a 34% bar. That is the model
reporting calibration, not a bug.

## Measured, on real calls

- Model: `jev-1.13.0` (alias `jev-latest`)
- Median latency: **~170–370 ms** end to end; the API returns
  `x-envoy-upstream-service-time` so model time is separable from network
- Input tokens are billed at **$0.042/MTok**; output tokens are free — a move
  costs on the order of a few hundredths of a cent

## Setup

Needs Python 3.9+ and a TypeSafe key from
[console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys).

The server looks for the key in `TYPESAFE_API_KEY`, then in
`~/.agents-md/.secrets/typesafe.env`. It is never logged, never sent to the
browser, and never placed in a URL or command-line argument. Nothing sensitive is
stored in this repo.

The only network dependency at runtime is `chess.js`, loaded from jsDelivr.
Everything else is stdlib.

## Layout

```
server.py              local server: holds the key, proxies /api/ask
static/app.js          Jev client, answer rendering, stats
static/chessgame.js    legal-move generation, tactical screen, heatmap
```

## Caveats

- This is a demo. The chess move distribution spreads over ~14 candidates, so
  per-move confidence is legitimately low (0.2–0.4). That is honest, not a
  defect.
- Vendor speed and cost claims were not independently reproduced; the numbers
  above are this app's own measurements on one machine.
- Earlier revisions of this lab also had Pong (confidence-gated real-time
  control) and camera-driven rock–paper–scissors demos; they were removed to
  focus the lab on chess. Their measured findings are in git history.
