// Must run BEFORE node-telegram-bot-api is loaded (imported first in
// index.js — ESM evaluates imports in order, so a plain top-level assignment
// in index.js would run too late).
// See https://github.com/yagop/node-telegram-bot-api/issues/540
process.env.NTBA_FIX_319 = '1';
process.env.NTBA_FIX_350 = '1';
