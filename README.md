# Cubehand

A Mineflayer bot for Minecraft Java that joins a server as its own survival player and takes requests from chat. Claude (through the Anthropic API) decides what to do, and the bot's code decides how: walking, digging, placing blocks in order, crafting, fighting.

It plays by survival rules. It only builds with blocks it carries, gets hungry, can die, and only sees the chunks around it.

## What it does

- Takes requests from players on an allowlist, addressed by name in chat or by whisper. "stop", "come here", "follow me" and "stay" are handled in code without waiting for the model.
- Builds from declarative plans: shapes, roofs, palettes, block mixes and ready-made detail kits. It renders an isometric preview of a larger plan before placing anything, and checks the finished build block by block.
- Mines, digs out boxes, chops trees, crafts, smelts, farms, breeds animals, fishes, trades, enchants and brews.
- Gets a wanted item in one call by planning the chain from its inventory, remembered chests, recipes and what it can mine nearby.
- Looks after itself: eats, gets to air, climbs out of lava, backs off to heal, goes back for its things after dying, and rejoins after a dropped connection.
- Does chores between jobs, and can keep a standing job going in rounds until told to stop.
- Remembers places, areas, chest contents and standing orders across restarts, writes lessons after jobs that went wrong, and saves routines of its own tool calls as skills.
- Routes each job to a quick, everyday or main model by how much thinking it needs, and logs the tokens and cost of every job.

## Requirements

- Node.js 20.6 or newer
- A Minecraft Java server the bot can join in offline mode
- An Anthropic API key

Mineflayer has to speak the server's protocol version. If the server is newer than Mineflayer supports, put a proxy such as ViaProxy in between and point the bot at the proxy.

## Setup

```
npm install
```

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. `CUBEHAND_PASSPHRASE` is optional: when set, players on the allowlist have to whisper it to the bot once per session before it takes their requests.

Copy `config.example.json` to `config.json` and fill in:

- `server`: host, port and the protocol version the bot connects with
- `bot.username`: the bot's player name
- `allowlist`: the players it listens to
- `admins`: the players who can give standing orders, have it break protected blocks, and use fire or lava. Defaults to the allowlist.

The rest of the file has working defaults: models and effort under `claude`, step, time and size limits under `limits`, and switches for idle chores, lessons, skills and standing jobs.

## Running

```
npm start
```

Then talk to it in game chat by name, for example `Clodine, build a small cottage here` with the default username.

```
npm test
npm run report
```

`npm test` runs the test suite with `node:test`. `npm run report` reads the job log (`jobs.jsonl`) and prints totals, cost and timing by model and tool, and jobs that ended early.

## Layout

- `src/index.js`: startup, connection and chat handling
- `src/brain*.js`: the tool-use loop, job queue, model routing, holds and standing jobs
- `src/actions/`: one file per action group (movement, building, mining, crafting, farming and so on)
- `src/perception.js`: the text snapshot of the world the model sees
- `src/render.js`: the PNG renderer for build plans and world boxes
- `src/idle.js`, `src/survival.js`: chores between jobs and the health and food watch
- `src/lessons.js`, `src/skills.js`, `src/memory.js`, `src/chests.js`: what it keeps between jobs
- `test/`: the tests

State files (`memory.json`, `chests.json`, `lessons.json`, `skills.json`, `jobs.jsonl` and others), `logs/` and `renders/` are written next to the code and kept out of the repo.

## Safety

- Every chat line the bot sends goes through a guard, so it can never start with a slash and run a command.
- Chat from players off the allowlist, sign text and name tags reach the model as information, never as instructions.
- Chests, beds and other protected blocks are only broken for an admin. Fire and lava are checked in code, and TNT is never used.
