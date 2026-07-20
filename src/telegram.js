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

import { createLogger } from '@gladysassistant/integration-sdk';
import { linkedMessage, notLinkedMessage, invalidCodeMessage } from './messages.js';

const logger = createLogger({ name: 'telegram' });

// Format of a Gladys link code: 8 characters from an unambiguous alphabet
// (no 0/O, 1/I/L), case-insensitive — mirror of the core generator. Anything
// matching this in a private chat is treated as a link attempt.
const LINK_CODE_REGEX = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/i;

// Outgoing images arrive as `image/jpg;base64,....` (or another subtype):
// Telegram wants the raw bytes.
const BASE64_IMAGE_PREFIX_REGEX = /^image\/[a-z]+;base64,/;

export class TelegramHandler {
  /**
   * @param {object} gladys - The GladysIntegration instance.
   * @param {Function} TelegramBotApi - The node-telegram-bot-api constructor.
   */
  constructor(gladys, TelegramBotApi) {
    this.gladys = gladys;
    this.TelegramBotApi = TelegramBotApi;
    this.bot = null;
    this.token = null;
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
      if (e.code === 'ETELEGRAM' && /: (401|404) /.test(e.message)) {
        await this.disconnect();
        await this.gladys
          .setConnectionStatus(false, {
            en: 'Telegram rejected the bot token. Check it in the configuration.',
            fr: 'Telegram a refusé le token du bot. Vérifiez-le dans la configuration.',
          })
          .catch(() => {});
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
   * Telegram contact.
   * @param {string} contactId - The Telegram chat id.
   * @param {{ text: string, file: string | null }} message - The message.
   */
  async sendMessage(contactId, message) {
    if (!this.bot) {
      throw new Error('Telegram bot is not connected');
    }
    logger.debug(`Sending Telegram message to contact ${contactId}`);
    await this.bot.sendMessage(contactId, message.text);
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
