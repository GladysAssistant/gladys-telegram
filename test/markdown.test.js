import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToTelegramHtml } from '../src/markdown.js';

test('non-string and empty values are returned untouched', () => {
  assert.equal(markdownToTelegramHtml(''), '');
  assert.equal(markdownToTelegramHtml(undefined), undefined);
  assert.equal(markdownToTelegramHtml(null), null);
  assert.equal(markdownToTelegramHtml(42), 42);
});

test('bold text becomes <b>', () => {
  assert.equal(
    markdownToTelegramHtml('La température actuelle dans le salon est de **27 °C**.'),
    'La température actuelle dans le salon est de <b>27 °C</b>.',
  );
  assert.equal(markdownToTelegramHtml('__Bold__ too'), '<b>Bold</b> too');
});

test('italic text becomes <i>', () => {
  assert.equal(markdownToTelegramHtml('It is *quite* warm'), 'It is <i>quite</i> warm');
  assert.equal(
    markdownToTelegramHtml('_Italic_ at the beginning'),
    '<i>Italic</i> at the beginning',
  );
});

test('underscores inside a word are left alone', () => {
  assert.equal(
    markdownToTelegramHtml('The device_feature_name is used'),
    'The device_feature_name is used',
  );
});

test('strikethrough becomes <s>', () => {
  assert.equal(markdownToTelegramHtml('~~Not anymore~~'), '<s>Not anymore</s>');
});

test('HTML characters are escaped', () => {
  assert.equal(
    markdownToTelegramHtml('5 < 6 & 7 > 6 "quoted"'),
    '5 &lt; 6 &amp; 7 &gt; 6 &quot;quoted&quot;',
  );
});

test('an HTML tag written by the user never goes through', () => {
  assert.equal(
    markdownToTelegramHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
});

test('a markdown link becomes an anchor', () => {
  assert.equal(
    markdownToTelegramHtml('See [the docs](https://gladysassistant.com/docs)'),
    'See <a href="https://gladysassistant.com/docs">the docs</a>',
  );
});

test('a markdown link with a title becomes an anchor', () => {
  assert.equal(
    markdownToTelegramHtml('See [the docs](https://gladysassistant.com "Docs")'),
    'See <a href="https://gladysassistant.com">the docs</a>',
  );
});

test('a link with an empty label falls back on the url', () => {
  assert.equal(
    markdownToTelegramHtml('[](https://gladysassistant.com)'),
    '<a href="https://gladysassistant.com">https://gladysassistant.com</a>',
  );
});

test('a link with an unsupported scheme stays plain text', () => {
  assert.equal(
    markdownToTelegramHtml('[click](javascript:alert(1))'),
    '[click](javascript:alert(1))',
  );
});

test('only the alt text of an image is kept', () => {
  assert.equal(markdownToTelegramHtml('![a camera](https://example.com/image.jpg)'), 'a camera');
});

test('headings become bold', () => {
  assert.equal(markdownToTelegramHtml('## Salon\nIl fait chaud'), '<b>Salon</b>\nIl fait chaud');
  assert.equal(markdownToTelegramHtml('# Titre #'), '<b>Titre</b>');
});

test('unordered lists become bullets', () => {
  assert.equal(
    markdownToTelegramHtml('- Salon\n* Cuisine\n+ Chambre'),
    '• Salon\n• Cuisine\n• Chambre',
  );
});

test('the indentation of a nested list is kept', () => {
  assert.equal(markdownToTelegramHtml('- Salon\n  - Lampe'), '• Salon\n  • Lampe');
});

test('ordered lists stay numbered', () => {
  assert.equal(markdownToTelegramHtml('1. Salon\n2) Cuisine'), '1. Salon\n2. Cuisine');
});

test('an horizontal rule becomes an empty line', () => {
  assert.equal(markdownToTelegramHtml('Salon\n\n---\n\nCuisine'), 'Salon\n\n\n\nCuisine');
});

test('a blockquote becomes <blockquote>', () => {
  assert.equal(
    markdownToTelegramHtml('> Line one\n> Line two\nAfter'),
    '<blockquote>Line one\nLine two</blockquote>\nAfter',
  );
});

test('a blockquote at the end of the message is closed', () => {
  assert.equal(
    markdownToTelegramHtml('Before\n> Quoted'),
    'Before\n<blockquote>Quoted</blockquote>',
  );
});

test('inline code becomes <code>', () => {
  assert.equal(
    markdownToTelegramHtml('Use `npm run start` to start'),
    'Use <code>npm run start</code> to start',
  );
});

test('markdown inside inline code is not converted', () => {
  assert.equal(markdownToTelegramHtml('`**not bold**`'), '<code>**not bold**</code>');
});

test('a fenced code block with a language becomes <pre><code>', () => {
  assert.equal(
    markdownToTelegramHtml('```js\nconst a = 1 < 2;\n```'),
    '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>',
  );
});

test('a fenced code block without a language becomes <pre>', () => {
  assert.equal(markdownToTelegramHtml('```\nhello\n```'), '<pre>hello</pre>');
});

test('the separator row of a table is dropped', () => {
  assert.equal(
    markdownToTelegramHtml('| Room | Temp |\n| --- | --- |\n| Salon | 27 |'),
    '| Room | Temp |\n| Salon | 27 |',
  );
});

test('the placeholder characters coming from the input are removed', () => {
  const withPlaceholderChars = `a${String.fromCharCode(0xe000)}0${String.fromCharCode(0xe001)}b`;
  assert.equal(markdownToTelegramHtml(withPlaceholderChars), 'a0b');
});

test('a full AI answer is converted', () => {
  const answer = [
    '## Salon',
    '',
    'La température actuelle est de **27 °C**, et l’humidité de *55 %*.',
    '',
    '- Capteur : `temperature-salon`',
    '- [Voir le détail](https://gladysassistant.com/dashboard)',
  ].join('\n');
  assert.equal(
    markdownToTelegramHtml(answer),
    [
      '<b>Salon</b>',
      '',
      'La température actuelle est de <b>27 °C</b>, et l’humidité de <i>55 %</i>.',
      '',
      '• Capteur : <code>temperature-salon</code>',
      '• <a href="https://gladysassistant.com/dashboard">Voir le détail</a>',
    ].join('\n'),
  );
});
