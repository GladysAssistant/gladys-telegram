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
import { TelegramHandler } from './src/telegram.js';

const gladys = new GladysIntegration();
const telegram = new TelegramHandler(gladys, TelegramBotApi);

const MISSING_TOKEN_STATUS = {
  en: 'No Telegram bot token configured. Create a bot with @BotFather and paste its token here.',
  fr: 'Aucun token de bot Telegram configuré. Créez un bot avec @BotFather et collez son token ici.',
};

const INVALID_TOKEN_STATUS = {
  en: 'Telegram rejected the bot token. Check it in the configuration.',
  fr: 'Telegram a refusé le token du bot. Vérifiez-le dans la configuration.',
};

// (Re)start the bot from the current configuration and report the
// application-level status shown in the Configuration screen.
async function startFromConfig(rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.telegram_api_token) {
    await telegram.disconnect();
    await gladys.setConnectionStatus(false, MISSING_TOKEN_STATUS);
    return;
  }
  try {
    await telegram.connect(config.telegram_api_token);
    // getMe() validates the token right away, instead of waiting for the
    // polling loop to fail in the background.
    const username = await telegram.getBotUsername();
    logger.info(`Telegram bot @${username} is up`);
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Failed to start the Telegram bot', err);
    await telegram.disconnect();
    await gladys.setConnectionStatus(false, INVALID_TOKEN_STATUS);
  }
}

// --- Outgoing: Gladys asks to deliver a message in the Telegram channel ------
// Brain replies and notifications forwarded to a linked user. Throwing acks
// the command as failed, so Gladys knows the message was not delivered.
gladys.onSendMessage(async (contactId, message) => {
  await telegram.sendMessage(contactId, message);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('Configuration updated, restarting the bot if needed');
  await startFromConfig(newConfig);
});

// --- Manifest action: "Test the bot token" button ----------------------------
gladys.onAction('test_connection', async () => {
  const config = normalizeConfig(gladys.config);
  if (!config.telegram_api_token) {
    return MISSING_TOKEN_STATUS;
  }
  await telegram.connect(config.telegram_api_token);
  const username = await telegram.getBotUsername();
  return {
    en: `Token valid: the bot @${username} is reachable.`,
    fr: `Token valide : le bot @${username} est joignable.`,
  };
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK fires 'connected' on every (re)connection, with `gladys.config`
// freshly resynchronized. TelegramHandler.connect() is a no-op when the bot
// already runs with the same token, so reconnections never interrupt polling.
gladys.on('connected', async () => {
  try {
    await startFromConfig(gladys.config);
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  await telegram.disconnect();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Telegram integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
