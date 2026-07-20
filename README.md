# Gladys Telegram

Official **Telegram** external integration for
[Gladys Assistant](https://gladysassistant.com): chat with your home from
Telegram — ask about your house, trigger scenes, and receive your Gladys
notifications (camera images included) in your Telegram account.

This is a **communication** integration (manifest `type: "communication"`),
built with the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
(v0.6.0+). It is the port of the historical in-core Telegram service of Gladys
(`server/services/telegram`) to the external integration model: same
`node-telegram-bot-api` long polling, same message flows — but running in its
own supervised Docker container.

## How it works

1. **Configure** — create a bot with [@BotFather](https://t.me/BotFather) on
   Telegram (`/newbot`) and paste its token in the integration configuration
   in Gladys.
2. **Link your account** — in Gladys, open the Telegram integration page and
   click **"Link my account"**: Gladys shows a short code (single use,
   15 minutes). Send that code to your bot in Telegram (or open the chat with
   `/start` and follow the instructions). The bot confirms the link.
3. **Chat** — everything you send to the bot is routed to the Gladys brain
   with the authority of your Gladys user; replies and notifications come back
   in the same chat.

Only **private chats** are handled: a linked contact speaks with the authority
of its Gladys user, so group chats (where anyone could talk to the bot) are
ignored.

## Message flows

| Direction | Path                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Incoming  | Telegram long polling → `gladys.publishMessage(contactId, text)` → brain + chat history. Unknown contact (404) → linking instructions reply |
| Linking   | Code sent in the chat → `gladys.linkContact(code, contactId, contactName)` → confirmation in the language of the linked user                |
| Outgoing  | `gladys.onSendMessage` → `bot.sendMessage` (+ `bot.sendPhoto` when the message carries an image)                                            |

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no Telegram logic)
├─ src/
│  ├─ telegram.js                    # Telegram handler: polling, linking, send/receive
│  ├─ messages.js                    # texts sent by the bot in the channel (en/fr)
│  ├─ config.js                      # config defaults + normalization
│  └─ env.js                         # node-telegram-bot-api env fixes (loaded first)
├─ gladys-assistant-integration.json # manifest (type: communication, config schema…)
├─ test/                             # node --test unit tests (fake bot + fake Gladys)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
├─ .github/workflows/release.yml     # UI-driven release: bump + tag + build
└─ .github/workflows/build.yml       # multi-arch image build (ghcr.io)
```

## Development

```bash
npm install
npm test              # node:test unit tests (fake bot, fake Gladys — no network)
npm run lint          # ESLint 10, flat config
npm run format:check  # Prettier
```

To run the integration against a Gladys instance outside Docker, export the
environment variables the supervisor normally injects, then `npm start`:

```bash
export GLADYS_HOST_API_URL=http://localhost:1443/api/v1/external_integration
export GLADYS_INTEGRATION_TOKEN=...   # integration-scoped JWT
export GLADYS_INTEGRATION_SELECTOR=...
npm start
```

## Release

From the GitHub UI: **Actions → Release → Run workflow** → pick
patch / minor / major. The workflow bumps `package.json` and the manifest,
tags `vX.Y.Z`, and publishes the multi-arch image
(`ghcr.io/gladysassistant/gladys-telegram:X.Y.Z` + `:latest`, linux/amd64 +
linux/arm64). The `gladys-assistant-integration` GitHub topic on this
repository is what makes it appear in the Gladys store.

## Requirements

- Gladys Assistant with communication-integrations support (see the
  `gladys_version` range in the manifest).
- A Telegram bot token from @BotFather.

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
