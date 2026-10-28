// -----------------------------------------------------------------------------
// Telegram handler: everything that talks to the Telegram Bot API.
//
// Port of the historical in-core Gladys Telegram service
// (server/services/telegram) to the external integration model:
//   - long polling through node-telegram-bot-api, like before;
//   - the user link is no longer a deep link resolved by the core: the user
//     generates a short code in the Gladys UI (single use, 15 minutes TTL)
//     and sends it to the bot; the handler relays it with
//     `gladys.linkContact(code, contactId, contactName)`;
//   - incoming messages go through `gladys.publishMessage(contactId, text)`
//     (Gladys resolves the linked user and routes to the brain); replies and
//     notifications come back through `sendMessage(contactId, message)`.
//
// The Telegram bot constructor is injected so the tests can run against a
// fake bot, without network nor a real token (same pattern as the in-core
// service).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { linkedMessage, notLinkedMessage, invalidCodeMessage } from './messages.js';
import { markdownToTelegramHtml } from './markdown.js';

const logger = createLogger({ name: 'telegram' });

// Format of a Gladys link code: 8 characters from an unambiguous alphabet
// (no 0/O, 1/I/L), case-insensitive — mirror of the core generator. Anything
// matching this in a private chat is treated as a link attempt.
const LINK_CODE_REGEX = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/i;

// Outgoing images arrive as `image/jpg;base64,....` (or another subtype):
// Telegram wants the raw bytes.
const BASE64_IMAGE_PREFIX_REGEX = /^image\/[a-z]+;base64,/;

// How long a message from Gladys may wait for the bot (at boot, the bot is
// started only after Gladys already relays messages) or for the previous
// message to the same contact. Gladys counts a `message.send` as failed when
// it is not acked within 5 s: past this budget the message is rejected rather
// than delivered after Gladys gave up on it.
const SEND_DEADLINE_MS = 3000;

// When Telegram cannot be reached, how long before checking the bot again.
const RETRY_DELAY_MS = 60 * 1000;

export const MISSING_TOKEN_STATUS = {
  en: 'No Telegram bot token configured. Create a bot with @BotFather and paste its token here.',
  fr: 'Aucun token de bot Telegram configuré. Créez un bot avec @BotFather et collez son token ici.',
};

const INVALID_TOKEN_STATUS = {
  en: 'Telegram rejected the bot token. Check it in the configuration.',
  fr: 'Telegram a refusé le token du bot. Vérifiez-le dans la configuration.',
};

const UNREACHABLE_STATUS = {
  en: 'Cannot reach Telegram right now. The integration retries every minute.',
  fr: "Impossible de joindre Telegram pour le moment. L'intégration réessaie chaque minute.",
};

/**
 * Whether Telegram itself rejected the request (400 Bad Request), which is
 * what a message carrying a tag it dislikes looks like. Only those are worth
 * retrying without formatting: a 400 means nothing was delivered, whereas a
 * network failure could have been a message that actually went through, and
 * re-sending it would duplicate it.
 * @param {Error} e - The error thrown by node-telegram-bot-api.
 * @returns {boolean} True when the request was rejected by Telegram.
 */
function isRejectedByTelegram(e) {
  return e?.code === 'ETELEGRAM' && e?.response?.body?.error_code === 400;
}

/**
 * Whether Telegram refused the bot token itself: 401 = invalid token, 404 =
 * revoked bot. Anything else (network down, DNS, Telegram 5xx/429) says
 * nothing about the token.
 * @param {Error} e - The error thrown or emitted by node-telegram-bot-api.
 * @returns {boolean} True when the token is rejected.
 */
export function isTokenRejected(e) {
  return e?.code === 'ETELEGRAM' && /: (401|404) /.test(e?.message);
}

export class TelegramHandler {
  /**
   * @param {object} gladys - The GladysIntegration instance.
   * @param {Function} TelegramBotApi - The node-telegram-bot-api constructor.
   * @param {object} [options] - Delays, shortened by the tests.
   * @param {number} [options.sendDeadlineMs] - See SEND_DEADLINE_MS.
   * @param {number} [options.retryDelayMs] - See RETRY_DELAY_MS.
   */
  constructor(
    gladys,
    TelegramBotApi,
    { sendDeadlineMs = SEND_DEADLINE_MS, retryDelayMs = RETRY_DELAY_MS } = {},
  ) {
    this.gladys = gladys;
    this.TelegramBotApi = TelegramBotApi;
    this.sendDeadlineMs = sendDeadlineMs;
    this.retryDelayMs = retryDelayMs;
    this.bot = null;
    this.token = null;
    this.retryTimer = null;
    // Start tracking, so sendMessage can wait for a bot about to come up
    // instead of failing: no start has finished yet at boot, and a start
    // may be under way.
    this.hasStarted = false;
    this.startsInFlight = 0;
    this.startEvents = new EventEmitter();
    // Contact id -> last delivery queued for that contact.
    this.deliveries = new Map();
  }

  /**
   * (Re)start the bot from the configuration and report the
   * application-level status shown in the Configuration screen.
   * @param {Record<string, unknown>} rawConfig - The integration configuration.
   */
  async startFromConfig(rawConfig) {
    this.startsInFlight += 1;
    try {
      await this.applyConfig(normalizeConfig(rawConfig));
    } finally {
      this.startsInFlight -= 1;
      this.hasStarted = true;
      this.startEvents.emit('settled');
    }
  }

  /**
   * @param {{ telegram_api_token: string }} config - The normalized configuration.
   */
  async applyConfig(config) {
    this.cancelRetry();
    if (!config.telegram_api_token) {
      await this.disconnect();
      await this.gladys.setConnectionStatus(false, MISSING_TOKEN_STATUS);
      return;
    }
    try {
      await this.connect(config.telegram_api_token);
      // getMe() validates the token right away, instead of waiting for the
      // polling loop to fail in the background.
      const username = await this.getBotUsername();
      logger.info(`Telegram bot @${username} is up`);
      await this.gladys.setConnectionStatus(true);
    } catch (err) {
      if (isTokenRejected(err)) {
        logger.error('Telegram rejected the bot token', err);
        await this.disconnect();
        await this.gladys.setConnectionStatus(false, INVALID_TOKEN_STATUS);
        return;
      }
      // Network down, DNS, Telegram 5xx/429: the token may well be valid. Keep
      // the polling loop (it retries on its own, and messages still go out
      // once the network is back) and check again later.
      logger.warn('Could not reach Telegram, retrying in a minute', err);
      this.scheduleRetry();
      await this.gladys.setConnectionStatus(false, UNREACHABLE_STATUS);
    }
  }

  // Check the bot again later, when Telegram could not be reached: the status
  // would otherwise stay on "unreachable" even after the network is back.
  scheduleRetry() {
    this.cancelRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startFromConfig(this.gladys.config).catch((err) => {
        logger.error('Telegram bot retry failed', err);
      });
    }, this.retryDelayMs);
  }

  cancelRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Stop the bot for good (shutdown): no retry, no polling loop. */
  async stop() {
    this.cancelRetry();
    await this.disconnect();
  }

  /**
   * Start the bot with the given token. Reconnecting with the token already
   * in use is a no-op, so the SDK 'connected' event (which fires again on
   * every WebSocket reconnection) never restarts a healthy polling loop.
   * @param {string} token - The Telegram bot token.
   */
  async connect(token) {
    if (this.bot && this.token === token) {
      logger.debug('Bot already connected with this token, nothing to do');
      return;
    }
    await this.disconnect();
    logger.info('Starting Telegram bot (long polling)');
    this.bot = new this.TelegramBotApi(token, { polling: true });
    this.token = token;
    this.bot.on('error', (e) => {
      logger.debug('Telegram error', e);
    });
    this.bot.on('polling_error', async (e) => {
      logger.warn(`Telegram polling error, code = ${e.code}, message = ${e.message}`);
      // 401 = invalid token, 404 = revoked bot: polling can never succeed
      // again, stop hammering the API and surface the problem in the UI.
      if (isTokenRejected(e)) {
        await this.disconnect();
        await this.gladys.setConnectionStatus(false, INVALID_TOKEN_STATUS).catch(() => {});
      }
    });
    this.bot.on('message', (msg) => {
      this.handleMessage(msg).catch((e) => {
        logger.error('Failed to handle incoming Telegram message', e);
      });
    });
  }

  /** Stop the polling loop and forget the bot. */
  async disconnect() {
    if (this.bot) {
      logger.debug('Stopping Telegram bot');
      await this.bot.stopPolling();
    }
    this.bot = null;
    this.token = null;
  }

  /** The username of the bot (without @), from the Telegram API. */
  async getBotUsername() {
    if (!this.bot) {
      throw new Error('Telegram bot is not connected');
    }
    const me = await this.bot.getMe();
    return me.username;
  }

  /**
   * Check a token against the Telegram API without touching the running bot:
   * the check uses its own client, with no polling loop.
   * @param {string} token - The Telegram bot token to check.
   * @returns {Promise<string>} The username of the bot (without @).
   */
  async checkToken(token) {
    const bot = new this.TelegramBotApi(token, { polling: false });
    const me = await bot.getMe();
    return me.username;
  }

  /**
   * Handle one incoming Telegram message.
   * @param {object} msg - The Telegram message.
   */
  async handleMessage(msg) {
    // A contact speaks with the authority of its linked Gladys user: only
    // one-to-one chats qualify (in a group, anyone could talk to the bot).
    if (!msg.chat || msg.chat.type !== 'private') {
      logger.debug('Ignoring message from a non-private chat');
      return;
    }
    if (typeof msg.text !== 'string' || msg.text.length === 0) {
      logger.debug('Ignoring non-text Telegram message');
      return;
    }
    const contactId = String(msg.chat.id);
    const text = msg.text.trim();
    logger.debug(`New message from Telegram contact ${contactId}`);

    // "/start" (with an optional deep-link payload) is the first contact
    // with the bot: link right away when a code is attached, otherwise
    // explain how to get one.
    if (text.startsWith('/start')) {
      const payload = text.split(' ')[1];
      if (payload) {
        await this.linkContact(payload, msg);
      } else {
        await this.bot.sendMessage(contactId, notLinkedMessage());
      }
      return;
    }

    // A message shaped like a link code is a link attempt: the code alphabet
    // is designed to never collide with a real sentence.
    if (LINK_CODE_REGEX.test(text)) {
      await this.linkContact(text, msg);
      return;
    }

    try {
      await this.gladys.publishMessage(contactId, text, {
        createdAt: new Date(msg.date * 1000).toISOString(),
      });
    } catch (e) {
      if (e.status === 404) {
        // Unknown contact: not linked yet.
        await this.bot.sendMessage(contactId, notLinkedMessage());
        return;
      }
      throw e;
    }
  }

  /**
   * Link the Telegram contact to the Gladys user who generated the code.
   * @param {string} code - The link code sent by the contact.
   * @param {object} msg - The Telegram message carrying the code.
   */
  async linkContact(code, msg) {
    const contactId = String(msg.chat.id);
    const contactName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
      msg.from?.username ||
      null;
    try {
      const user = await this.gladys.linkContact(code, contactId, contactName ?? undefined);
      logger.info(`Telegram contact ${contactId} linked to Gladys user ${user.selector}`);
      await this.bot.sendMessage(contactId, linkedMessage(user));
    } catch (e) {
      if (e.status === 404) {
        await this.bot.sendMessage(contactId, invalidCodeMessage());
        return;
      }
      throw e;
    }
  }

  /**
   * Deliver a Gladys message (brain reply or forwarded notification) to a
   * Telegram contact. `message.text` is Markdown (contract of `message.send`):
   * it is rendered into the HTML subset Telegram understands, otherwise the
   * user reads the raw syntax ("**27 °C**").
   * @param {string} contactId - The Telegram chat id.
   * @param {{ text: string, file: string | null }} message - The message.
   */
  async sendMessage(contactId, message) {
    // The budget starts when Gladys hands the message over, see SEND_DEADLINE_MS.
    const deadline = Date.now() + this.sendDeadlineMs;
    // One message at a time per contact, in the order Gladys sent them: the
    // messages held at boot are all released together once the bot is up, and
    // sending them in parallel lets Telegram deliver them out of order.
    const previous = this.deliveries.get(contactId) ?? Promise.resolve();
    const delivery = previous.then(() => this.deliver(contactId, message, deadline));
    const settled = delivery.catch(() => {});
    this.deliveries.set(contactId, settled);
    settled.then(() => {
      if (this.deliveries.get(contactId) === settled) {
        this.deliveries.delete(contactId);
      }
    });
    return delivery;
  }

  /**
   * Wait until the bot is up, as long as a start may still bring it up.
   * Once the bot is down for good (no token, token rejected), fail at once.
   * @param {number} deadline - Timestamp after which to stop waiting.
   */
  async waitForBot(deadline) {
    // At boot Gladys relays the pending notifications (the "Gladys starts"
    // scenes, the upgrade message) as soon as the container authenticates on
    // the WebSocket, before the 'connected' handler has started the bot.
    while (!this.bot && (!this.hasStarted || this.startsInFlight > 0)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await this.nextStartSettled(remaining);
    }
    if (!this.bot) {
      throw new Error('Telegram bot is not connected');
    }
  }

  /**
   * Resolve when a start finishes, or after `ms`, whichever comes first.
   * @param {number} ms - The longest wait.
   */
  nextStartSettled(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.startEvents.off('settled', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.startEvents.once('settled', done);
    });
  }

  /**
   * Send one message to Telegram, once its turn has come.
   * @param {string} contactId - The Telegram chat id.
   * @param {{ text: string, file: string | null }} message - The message.
   * @param {number} deadline - Timestamp after which Gladys counts it as failed.
   */
  async deliver(contactId, message, deadline) {
    await this.waitForBot(deadline);
    if (Date.now() > deadline) {
      throw new Error('Telegram message not sent in time: Gladys counts it as failed');
    }
    logger.debug(`Sending Telegram message to contact ${contactId}`);
    if (message.text) {
      try {
        await this.bot.sendMessage(contactId, markdownToTelegramHtml(message.text), {
          parse_mode: 'HTML',
        });
      } catch (e) {
        // Telegram rejects the whole message when it dislikes one tag: rather
        // than losing the answer, send the raw text without any formatting
        if (!isRejectedByTelegram(e)) {
          throw e;
        }
        logger.warn('Telegram refused the formatted message, falling back to plain text', e);
        await this.bot.sendMessage(contactId, message.text);
      }
    }
    if (message.file) {
      const image = Buffer.from(message.file.replace(BASE64_IMAGE_PREFIX_REGEX, ''), 'base64');
      await this.bot.sendPhoto(
        contactId,
        image,
        {},
        { filename: 'image', contentType: 'image/jpg' },
      );
    }
  }
}
