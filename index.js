// -----------------------------------------------------------------------------
// Entry point of the Gladys Telegram external integration.
//
// Role of this file: wire the SDK to the Telegram handler (src/telegram.js).
// It holds NO Telegram logic — it only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. starts (or restarts) the bot when the configuration is available.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import './src/env.js';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import TelegramBotApi from 'node-telegram-bot-api';
import { normalizeConfig } from './src/config.js';
import { TelegramHandler, MISSING_TOKEN_STATUS } from './src/telegram.js';

const gladys = new GladysIntegration();
const telegram = new TelegramHandler(gladys, TelegramBotApi);

// --- Outgoing: Gladys asks to deliver a message in the Telegram channel ------
// Brain replies and notifications forwarded to a linked user. Throwing acks
// the command as failed, so Gladys knows the message was not delivered.
//
// `contact` is the identity resolved by Gladys (SDK v0.9+): for a bidirectional
// channel like this one (`messaging.receive: true`), it carries the linked
// contact id — here the Telegram chat id. Send-only channels would receive
// their `contact_schema` values instead.
gladys.onSendMessage(async (contact, message) => {
  await telegram.sendMessage(contact.id, message);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('Configuration updated, restarting the bot if needed');
  await telegram.startFromConfig(newConfig);
});

// --- Manifest action: "Test the bot token" button ----------------------------
gladys.onAction('test_connection', async () => {
  const config = normalizeConfig(gladys.config);
  if (!config.telegram_api_token) {
    return MISSING_TOKEN_STATUS;
  }
  // Checked with a separate client: the test never restarts nor stops the
  // running bot.
  const username = await telegram.checkToken(config.telegram_api_token);
  return {
    en: `Token valid: the bot @${username} is reachable.`,
    fr: `Token valide : le bot @${username} est joignable.`,
  };
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK fires 'connected' on every (re)connection, with `gladys.config`
// freshly resynchronized. TelegramHandler.connect() is a no-op when the bot
// already runs with the same token, so reconnections never interrupt polling.
// Messages Gladys relays before this first start wait for it (bounded) in
// TelegramHandler.sendMessage.
gladys.on('connected', async () => {
  try {
    await telegram.startFromConfig(gladys.config);
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  await telegram.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Telegram integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
