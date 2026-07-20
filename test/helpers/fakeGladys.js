// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the Telegram handler relies on:
//   - publishMessage(contactId, text, opts) -> record calls, 404 on unknown
//     contacts (like the real host API);
//   - linkContact(code, contactId, name)    -> record calls, resolve the
//     configured user or reject with a 404;
//   - setConnectionStatus                   -> record calls.
// This lets us test the message routing logic without a running Gladys
// server or a real WebSocket.
// -----------------------------------------------------------------------------

class FakeGladysApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createFakeGladys({ linkedContacts = [], linkCodes = {} } = {}) {
  const publishedMessages = [];
  const linkAttempts = [];
  const connectionStatuses = [];
  const linked = new Set(linkedContacts);

  return {
    publishedMessages,
    linkAttempts,
    connectionStatuses,
    config: {},

    async publishMessage(contactId, text, options) {
      if (!linked.has(contactId)) {
        throw new FakeGladysApiError(404, 'NOT_FOUND', 'Contact not linked');
      }
      publishedMessages.push({ contactId, text, options });
    },

    async linkContact(code, contactId, contactName) {
      linkAttempts.push({ code, contactId, contactName });
      const user = linkCodes[code.toUpperCase()];
      if (!user) {
        throw new FakeGladysApiError(404, 'NOT_FOUND', 'INVALID_LINK_CODE');
      }
      linked.add(contactId);
      return user;
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}
