// -----------------------------------------------------------------------------
// Messages the bot sends in the Telegram channel.
//
// Once a contact is linked we know the language of the Gladys user and answer
// in it; before the link we know nothing about the contact, so the onboarding
// messages carry both languages in one short text.
// -----------------------------------------------------------------------------

const MESSAGES = {
  linked: {
    en: (firstName) =>
      `👋 Hi ${firstName}! Your Telegram account is now linked to Gladys. Ask me anything!`,
    fr: (firstName) =>
      `👋 Bonjour ${firstName} ! Votre compte Telegram est maintenant lié à Gladys. Demandez-moi ce que vous voulez !`,
  },
};

const NOT_LINKED_MESSAGE = [
  '🔗 Your Telegram account is not linked to Gladys yet.',
  'Open Gladys → Integrations → Telegram, click "Link my account", then send me the code you get.',
  '',
  "🔗 Votre compte Telegram n'est pas encore lié à Gladys.",
  'Ouvrez Gladys → Intégrations → Telegram, cliquez sur « Lier mon compte », puis envoyez-moi le code obtenu.',
].join('\n');

const INVALID_CODE_MESSAGE = [
  '❌ This code is invalid or has expired. Generate a new one from the Telegram page in Gladys.',
  '❌ Ce code est invalide ou a expiré. Générez-en un nouveau depuis la page Telegram de Gladys.',
].join('\n');

/**
 * Message sent right after a successful link, in the language of the linked
 * Gladys user (english fallback).
 * @param {{ first_name: string, language: string }} user - The linked user.
 */
export function linkedMessage(user) {
  const build = MESSAGES.linked[user.language] ?? MESSAGES.linked.en;
  return build(user.first_name);
}

/** Onboarding message for a contact that is not linked yet (bilingual). */
export function notLinkedMessage() {
  return NOT_LINKED_MESSAGE;
}

/** Message for an invalid or expired link code (bilingual). */
export function invalidCodeMessage() {
  return INVALID_CODE_MESSAGE;
}
