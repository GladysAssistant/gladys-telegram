import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramHandler, isTokenRejected } from '../src/telegram.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { FakeTelegramBot } from './helpers/fakeBot.js';

const LINKED_USER = { selector: 'john', first_name: 'John', language: 'en' };

function privateMessage(text, { chatId = 1234, date = 1752969600 } = {}) {
  return {
    text,
    date,
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, first_name: 'John', last_name: 'Doe', username: 'johndoe' },
  };
}

beforeEach(() => {
  FakeTelegramBot.reset();
});

test('connect starts polling and reconnecting with the same token is a no-op', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token-a');
  const firstBot = FakeTelegramBot.last;
  await handler.connect('token-a');
  assert.equal(FakeTelegramBot.instances.length, 1);
  assert.equal(firstBot.polling, true);
});

test('connect with a new token stops the previous bot and starts a new one', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token-a');
  const firstBot = FakeTelegramBot.last;
  await handler.connect('token-b');
  assert.equal(firstBot.polling, false);
  assert.equal(FakeTelegramBot.instances.length, 2);
  assert.equal(FakeTelegramBot.last.token, 'token-b');
});

test('an incoming message from a linked contact is published to Gladys', async () => {
  const gladys = createFakeGladys({ linkedContacts: ['1234'] });
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('token');

  await handler.handleMessage(privateMessage('Turn on the light'));

  assert.equal(gladys.publishedMessages.length, 1);
  const published = gladys.publishedMessages[0];
  assert.equal(published.contactId, '1234');
  assert.equal(published.text, 'Turn on the light');
  assert.equal(published.options.createdAt, new Date(1752969600 * 1000).toISOString());
});

test('an unknown contact gets the linking instructions', async () => {
  const gladys = createFakeGladys();
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('token');

  await handler.handleMessage(privateMessage('Hello?'));

  assert.equal(gladys.publishedMessages.length, 0);
  assert.equal(FakeTelegramBot.last.sentMessages.length, 1);
  assert.match(FakeTelegramBot.last.sentMessages[0].text, /not linked/);
});

test('a valid link code links the contact and confirms in the user language', async () => {
  const gladys = createFakeGladys({ linkCodes: { AB23CD45: LINKED_USER } });
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('token');

  await handler.handleMessage(privateMessage('ab23cd45'));

  assert.deepEqual(gladys.linkAttempts, [
    { code: 'ab23cd45', contactId: '1234', contactName: 'John Doe' },
  ]);
  assert.match(FakeTelegramBot.last.sentMessages[0].text, /John/);

  // The contact is now linked: the next message reaches Gladys.
  await handler.handleMessage(privateMessage('What temperature is it?'));
  assert.equal(gladys.publishedMessages.length, 1);
});

test('an invalid link code gets the invalid-code message', async () => {
  const gladys = createFakeGladys();
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('token');

  await handler.handleMessage(privateMessage('ZZZZZZZZ'));

  assert.equal(gladys.linkAttempts.length, 1);
  assert.match(FakeTelegramBot.last.sentMessages[0].text, /invalid|invalide/);
});

test('/start with a deep-link payload is a link attempt', async () => {
  const gladys = createFakeGladys({ linkCodes: { AB23CD45: LINKED_USER } });
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('token');

  await handler.handleMessage(privateMessage('/start AB23CD45'));

  assert.equal(gladys.linkAttempts.length, 1);
  assert.match(FakeTelegramBot.last.sentMessages[0].text, /John/);
});

test('/start without payload sends the linking instructions', async () => {
  const gladys = createFakeGladys();
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('token');

  await handler.handleMessage(privateMessage('/start'));

  assert.equal(gladys.linkAttempts.length, 0);
  assert.match(FakeTelegramBot.last.sentMessages[0].text, /Link my account|Lier mon compte/);
});

test('group chats and non-text messages are ignored', async () => {
  const gladys = createFakeGladys({ linkedContacts: ['1234'] });
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('token');

  await handler.handleMessage({
    text: 'hello from a group',
    date: 1752969600,
    chat: { id: -99, type: 'group' },
    from: { id: 1234 },
  });
  await handler.handleMessage({ ...privateMessage('x'), text: undefined });

  assert.equal(gladys.publishedMessages.length, 0);
  assert.equal(FakeTelegramBot.last.sentMessages.length, 0);
});

test('sendMessage delivers the text, and the image when there is one', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token');

  await handler.sendMessage('1234', { text: 'Camera image', file: null });
  assert.equal(FakeTelegramBot.last.sentPhotos.length, 0);

  const pixel = Buffer.from('fake-jpeg-bytes').toString('base64');
  await handler.sendMessage('1234', { text: 'Camera image', file: `image/jpg;base64,${pixel}` });

  const bot = FakeTelegramBot.last;
  assert.equal(bot.sentMessages.length, 2);
  assert.equal(bot.sentPhotos.length, 1);
  assert.deepEqual(bot.sentPhotos[0].photo, Buffer.from('fake-jpeg-bytes'));
  assert.equal(bot.sentPhotos[0].fileOptions.contentType, 'image/jpg');
});

test('sendMessage renders the markdown into Telegram HTML', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token');

  await handler.sendMessage('1234', { text: 'It is **27 °C** in the living room.', file: null });

  const sent = FakeTelegramBot.last.sentMessages[0];
  assert.equal(sent.text, 'It is <b>27 °C</b> in the living room.');
  assert.equal(sent.options.parse_mode, 'HTML');
});

// the error shape of node-telegram-bot-api: `code`, plus the raw Telegram
// answer under `response.body`
function telegramError(errorCode, description) {
  const error = new Error(`ETELEGRAM: ${errorCode} ${description}`);
  error.code = 'ETELEGRAM';
  error.response = { body: { ok: false, error_code: errorCode, description } };
  return error;
}

function failFormattedSend(bot, error) {
  const recordMessage = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, options) => {
    if (options?.parse_mode) {
      throw error;
    }
    return recordMessage(chatId, text, options);
  };
}

test('sendMessage falls back to plain text when Telegram refuses the formatting', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token');
  const bot = FakeTelegramBot.last;
  failFormattedSend(bot, telegramError(400, "Bad Request: can't parse entities"));

  await handler.sendMessage('1234', { text: 'It is **27 °C**.', file: null });

  assert.equal(bot.sentMessages.length, 1);
  assert.equal(bot.sentMessages[0].text, 'It is **27 °C**.');
  assert.equal(bot.sentMessages[0].options, undefined);
});

test('sendMessage does not retry a send that failed for another reason', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token');
  const bot = FakeTelegramBot.last;
  // a network failure may well have delivered the message: retrying it would
  // send it twice
  const networkError = new Error('EFATAL: network is down');
  networkError.code = 'EFATAL';
  failFormattedSend(bot, networkError);

  await assert.rejects(
    () => handler.sendMessage('1234', { text: 'It is **27 °C**.', file: null }),
    /network is down/,
  );
  assert.equal(bot.sentMessages.length, 0);
});

test('sendMessage does not retry when the contact blocked the bot', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token');
  const bot = FakeTelegramBot.last;
  failFormattedSend(bot, telegramError(403, 'Forbidden: bot was blocked by the user'));

  await assert.rejects(
    () => handler.sendMessage('1234', { text: 'Hello', file: null }),
    /blocked by the user/,
  );
  assert.equal(bot.sentMessages.length, 0);
});

test('sendMessage sends no text message when the message carries only an image', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token');
  const pixel = Buffer.from('fake-jpeg-bytes').toString('base64');

  await handler.sendMessage('1234', { text: '', file: `image/jpg;base64,${pixel}` });

  const bot = FakeTelegramBot.last;
  assert.equal(bot.sentMessages.length, 0);
  assert.equal(bot.sentPhotos.length, 1);
});

test('sendMessage waits for the first start of the bot', async () => {
  const gladys = createFakeGladys();
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  const sending = handler.sendMessage('1234', { text: 'Gladys started', file: null });
  await handler.startFromConfig({ telegram_api_token: 'token' });
  await sending;
  assert.equal(FakeTelegramBot.last.sentMessages.length, 1);
  assert.equal(FakeTelegramBot.last.sentMessages[0].text, 'Gladys started');
});

test('messages held during the start are sent one after the other, in order', async () => {
  class SlowFirstSendBot extends FakeTelegramBot {
    async sendMessage(chatId, text, options) {
      if (this.sentMessages.length === 0 && !this.slowed) {
        this.slowed = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return super.sendMessage(chatId, text, options);
    }
  }
  const handler = new TelegramHandler(createFakeGladys(), SlowFirstSendBot);
  const first = handler.sendMessage('1234', { text: 'Gladys was upgraded', file: null });
  const second = handler.sendMessage('1234', { text: 'Release notes', file: null });
  await handler.startFromConfig({ telegram_api_token: 'token' });
  await Promise.all([first, second]);
  assert.deepEqual(
    FakeTelegramBot.last.sentMessages.map((sent) => sent.text),
    ['Gladys was upgraded', 'Release notes'],
  );
});

test('a failed send does not block the next message to the same contact', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.startFromConfig({ telegram_api_token: 'token' });
  const bot = FakeTelegramBot.last;
  const recordMessage = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, options) => {
    if (text === 'one') {
      throw new Error('EFATAL: socket hang up');
    }
    return recordMessage(chatId, text, options);
  };
  const first = handler.sendMessage('1234', { text: 'one', file: null });
  const second = handler.sendMessage('1234', { text: 'two', file: null });
  await assert.rejects(() => first, /socket hang up/);
  await second;
  assert.deepEqual(
    bot.sentMessages.map((sent) => sent.text),
    ['two'],
  );
});

test('sendMessage throws when the bot did not come up at startup', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  const sending = handler.sendMessage('1234', { text: 'hi', file: null });
  await handler.startFromConfig({ telegram_api_token: '' });
  await assert.rejects(() => sending, /not connected/);
});

test('sendMessage gives up when the bot does not start in time', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot, { sendDeadlineMs: 20 });
  await assert.rejects(
    () => handler.sendMessage('1234', { text: 'Door opened', file: null }),
    /not connected/,
  );
  // A start that comes later never delivers the message Gladys gave up on.
  await handler.startFromConfig({ telegram_api_token: 'token' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeTelegramBot.last.sentMessages.length, 0);
});

test('a message held at boot goes out when Telegram is unreachable at first', async () => {
  class UnreachableBot extends FakeTelegramBot {
    async getMe() {
      const error = new Error('EFATAL: getaddrinfo ENOTFOUND api.telegram.org');
      error.code = 'EFATAL';
      throw error;
    }
  }
  const gladys = createFakeGladys();
  const handler = new TelegramHandler(gladys, UnreachableBot);
  const sending = handler.sendMessage('1234', { text: 'Gladys started', file: null });
  await handler.startFromConfig({ telegram_api_token: 'token' });
  await sending;
  assert.equal(FakeTelegramBot.last.sentMessages.length, 1);
  assert.equal(gladys.connectionStatuses[0].connected, false);
  assert.match(gladys.connectionStatuses[0].message.en, /Cannot reach Telegram/);
  await handler.stop();
});

test('a rejected token at startup stops the bot and reports it', async () => {
  class RejectingBot extends FakeTelegramBot {
    async getMe() {
      throw telegramError(401, 'Unauthorized');
    }
  }
  const gladys = createFakeGladys();
  const handler = new TelegramHandler(gladys, RejectingBot);
  await handler.startFromConfig({ telegram_api_token: 'bad-token' });
  assert.equal(handler.bot, null);
  assert.equal(handler.retryTimer, null);
  assert.match(gladys.connectionStatuses[0].message.en, /rejected the bot token/);
});

test('sendMessage throws when the bot is not connected', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.startFromConfig({});
  await assert.rejects(
    () => handler.sendMessage('1234', { text: 'hi', file: null }),
    /not connected/,
  );
});

test('a fatal polling error stops the bot and reports the status', async () => {
  const gladys = createFakeGladys();
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('bad-token');
  const bot = FakeTelegramBot.last;

  bot.emit('polling_error', {
    code: 'ETELEGRAM',
    message: 'ETELEGRAM: 401 Unauthorized',
  });
  // the polling_error handler is async: let it run
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bot.polling, false);
  assert.equal(handler.bot, null);
  assert.equal(gladys.connectionStatuses.length, 1);
  assert.equal(gladys.connectionStatuses[0].connected, false);
});

test('a transient polling error keeps the bot running', async () => {
  const gladys = createFakeGladys();
  const handler = new TelegramHandler(gladys, FakeTelegramBot);
  await handler.connect('token');
  const bot = FakeTelegramBot.last;

  bot.emit('polling_error', { code: 'EFATAL', message: 'EFATAL: network is down' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bot.polling, true);
  assert.equal(handler.bot, bot);
  assert.equal(gladys.connectionStatuses.length, 0);
});

test('isTokenRejected only matches an invalid token or a revoked bot', () => {
  assert.equal(isTokenRejected(telegramError(401, 'Unauthorized')), true);
  assert.equal(isTokenRejected(telegramError(404, 'Not Found')), true);
  assert.equal(isTokenRejected(telegramError(429, 'Too Many Requests')), false);
  assert.equal(isTokenRejected(telegramError(502, 'Bad Gateway')), false);
  const networkError = new Error('EFATAL: getaddrinfo ENOTFOUND api.telegram.org');
  networkError.code = 'EFATAL';
  assert.equal(isTokenRejected(networkError), false);
  assert.equal(isTokenRejected(undefined), false);
});

test('checkToken uses its own client and leaves the running bot alone', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token-a');
  const runningBot = FakeTelegramBot.last;

  const username = await handler.checkToken('token-a');

  assert.equal(username, 'GladysTestBot');
  assert.equal(FakeTelegramBot.instances.length, 2);
  assert.equal(FakeTelegramBot.last.options.polling, false);
  assert.equal(handler.bot, runningBot);
  assert.equal(runningBot.polling, true);
});

test('checkToken with a rejected token neither starts nor stops a bot', async () => {
  class RejectingBot extends FakeTelegramBot {
    async getMe() {
      throw telegramError(401, 'Unauthorized');
    }
  }
  const handler = new TelegramHandler(createFakeGladys(), RejectingBot);

  await assert.rejects(() => handler.checkToken('bad-token'), /401/);
  assert.equal(handler.bot, null);
  assert.equal(FakeTelegramBot.last.options.polling, false);
});
