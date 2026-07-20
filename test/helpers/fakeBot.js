// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for node-telegram-bot-api, for unit tests.
//
// The handler receives the CONSTRUCTOR (dependency injection), so the tests
// hand it this class and drive it: `bot.emit('message', msg)` simulates an
// incoming Telegram message, `bot.sentMessages` / `bot.sentPhotos` record
// what the handler sent back.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export class FakeTelegramBot extends EventEmitter {
  static instances = [];

  constructor(token, options) {
    super();
    this.token = token;
    this.options = options;
    this.polling = true;
    this.sentMessages = [];
    this.sentPhotos = [];
    this.username = 'GladysTestBot';
    FakeTelegramBot.instances.push(this);
  }

  static reset() {
    FakeTelegramBot.instances = [];
  }

  static get last() {
    return FakeTelegramBot.instances[FakeTelegramBot.instances.length - 1];
  }

  async stopPolling() {
    this.polling = false;
  }

  async getMe() {
    return { id: 42, is_bot: true, username: this.username };
  }

  async sendMessage(chatId, text, options) {
    this.sentMessages.push({ chatId, text, options });
  }

  async sendPhoto(chatId, photo, options, fileOptions) {
    this.sentPhotos.push({ chatId, photo, options, fileOptions });
  }
}
