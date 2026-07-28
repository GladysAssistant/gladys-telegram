import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramHandler } from '../src/telegram.js';
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

test('sendMessage falls back to plain text when Telegram refuses the formatting', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
  await handler.connect('token');
  const bot = FakeTelegramBot.last;
  const recordMessage = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, options) => {
    if (options?.parse_mode) {
      throw new Error("ETELEGRAM: 400 Bad Request: can't parse entities");
    }
    return recordMessage(chatId, text, options);
  };

  await handler.sendMessage('1234', { text: 'It is **27 °C**.', file: null });

  assert.equal(bot.sentMessages.length, 1);
  assert.equal(bot.sentMessages[0].text, 'It is **27 °C**.');
  assert.equal(bot.sentMessages[0].options, undefined);
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

test('sendMessage throws when the bot is not connected', async () => {
  const handler = new TelegramHandler(createFakeGladys(), FakeTelegramBot);
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
