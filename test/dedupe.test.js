const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/psl-data.js');
require('../src/site.js');
require('../src/parse.js');
require('../src/dedupe.js');
const { site, parse, dedupe } = globalThis.VD;

let seq = 0;
function bw(uri, username, password, extra = {}) {
  const { login = {}, ...rest } = extra;
  return {
    id: 'bw-' + ++seq,
    type: 1,
    name: rest.name || [].concat(uri)[0] || 'Untitled',
    notes: null,
    favorite: false,
    reprompt: 0,
    folderId: null,
    organizationId: null,
    revisionDate: '2026-01-01T00:00:00.000Z',
    ...rest,
    login: { uris: [].concat(uri).map((u) => ({ match: null, uri: u })), username, password, totp: null, ...login },
  };
}

function bwFile(items, folders = []) {
  return parse.parseFile('vault.json', JSON.stringify({ encrypted: false, folders, items }));
}

function chromeFile(rows) {
  const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = ['name,url,username,password,note', ...rows.map((r) => r.map(esc).join(','))];
  return parse.parseFile('Chrome Passwords.csv', lines.join('\n'));
}

function run(files, settings = { mergeDifferentPasswords: true }, excluded = new Set()) {
  const entries = dedupe.prepare(files);
  const analysis = dedupe.analyze(entries, settings);
  const output = dedupe.buildOutput(files, entries, analysis, excluded);
  return { entries, analysis, output, items: output.vault.items };
}

test('site: subdomains collapse to the registrable domain, hosting platforms do not', () => {
  assert.equal(site.siteOf('https://careers.tiktok.com/x').key, 'tiktok.com');
  assert.equal(site.siteOf('www.tiktok.com').key, 'tiktok.com');
  assert.equal(site.siteOf('https://shop.example.co.uk').key, 'example.co.uk');
  assert.equal(site.siteOf('https://foo.github.io').key, 'foo.github.io');
  assert.equal(site.siteOf('https://192.168.1.1:8080/login').key, '192.168.1.1:8080');
  assert.equal(site.siteOf('android://abc==@com.zhiliaoapp.musically/').key, 'app:com.zhiliaoapp.musically');
  assert.equal(site.siteOf('androidapp://com.zhiliaoapp.musically').key, 'app:com.zhiliaoapp.musically');
  assert.equal(site.siteOf('chrome-extension://abc'), null);
});

test('exact duplicates across www/apex/subdomain and Chrome/Bitwarden merge into one entry', () => {
  const { analysis, items } = run([
    bwFile([bw('https://www.tiktok.com', 'Me@Example.test', 'pw1', { notes: 'from bitwarden' })]),
    chromeFile([
      ['tiktok.com', 'https://tiktok.com/', 'me@example.test', 'pw1', ''],
      ['careers', 'https://careers.tiktok.com/', 'me@example.test', 'pw1', 'chrome note'],
    ]),
  ]);
  assert.equal(items.length, 1);
  assert.equal(analysis.groups[0].kind, 'exact');
  assert.equal(analysis.groups[0].kept.source, 'Bitwarden');
  assert.deepEqual(
    items[0].login.uris.map((u) => u.uri),
    ['https://www.tiktok.com', 'https://tiktok.com/', 'https://careers.tiktok.com/'],
  );
  assert.equal(items[0].notes, 'from bitwarden\n\nchrome note');
  assert.equal(items[0].passwordHistory, undefined);
});

test('the password both Chrome and Bitwarden have wins; the other goes to history', () => {
  const { analysis, items } = run([
    bwFile([bw('https://tiktok.com', 'me', 'stale'), bw('https://tiktok.com/login', 'me', 'current')]),
    chromeFile([['tiktok', 'https://www.tiktok.com', 'me', 'current', '']]),
  ]);
  assert.equal(items.length, 1);
  assert.equal(analysis.groups[0].kind, 'older');
  assert.equal(items[0].login.password, 'current');
  assert.deepEqual(items[0].passwordHistory.map((h) => h.password), ['stale']);
  assert.match(analysis.groups[0].removed.find((r) => r.entry.password === 'stale').reason, /in Chrome and in a dated Bitwarden entry/);
});

test("when nothing tells which password is current, both entries are kept", () => {
  const { analysis, items } = run([
    bwFile([bw('https://tiktok.com', 'me', 'bitwarden-one', { revisionDate: '2026-03-01T00:00:00.000Z' })]),
    chromeFile([['tiktok', 'https://www.tiktok.com', 'me', 'chrome-one', '']]),
  ]);
  assert.equal(items.length, 2);
  assert.equal(analysis.groups.length, 0);
  assert.match(analysis.separate[0].reason, /Can't tell which password is current/);
});

test('bulk-import dates are ignored (real case: three copies imported today, real password in Chrome)', () => {
  const imported = { creationDate: '2026-10-12T09:15:20.000Z', revisionDate: '2026-10-12T09:15:20.000Z' };
  const { analysis, items, entries } = run([
    bwFile([
      bw('https://linkedin.com', 'me@x.test', 'lowercase-wrong', imported),
      bw('https://www.linkedin.com', 'me@x.test', 'other-wrong', imported),
      bw('https://linkedin.com', 'me@x.test', 'Right-One', imported),
      bw('https://linkedin.com', 'me@x.test', 'Right-One', { creationDate: '2024-01-10T08:00:00.000Z' }),
      bw('https://a1.com', 'u', 'p', imported),
      bw('https://a2.com', 'u', 'p', imported),
    ]),
    chromeFile([['www.linkedin.com', 'https://www.linkedin.com/', 'me@x.test', 'Right-One', '']]),
  ]);
  assert.equal(entries[0].time, null);
  assert.ok(entries[0].bulkDate);
  const linkedin = items.find((i) => i.login.uris.some((u) => u.uri.includes('linkedin')));
  assert.equal(linkedin.login.password, 'Right-One');
  assert.deepEqual(linkedin.passwordHistory.map((h) => h.password).sort(), ['lowercase-wrong', 'other-wrong']);
  assert.equal(analysis.groups.find((g) => g.sites.includes('linkedin.com')).removed.length, 4);
});

test('newer revision date wins between two Bitwarden entries; password history beats dates', () => {
  const byDate = run([
    bwFile([
      bw('https://a.com', 'me', 'old', { revisionDate: '2025-01-01T00:00:00.000Z' }),
      bw('https://a.com', 'me', 'new', { revisionDate: '2026-01-01T00:00:00.000Z' }),
    ]),
  ]);
  assert.equal(byDate.items[0].login.password, 'new');

  const byHistory = run([
    bwFile([
      bw('https://b.com', 'me', 'current', {
        revisionDate: '2025-01-01T00:00:00.000Z',
        passwordHistory: [{ lastUsedDate: '2024-06-01T00:00:00.000Z', password: 'stale' }],
      }),
      bw('https://b.com', 'me', 'stale', { revisionDate: '2026-01-01T00:00:00.000Z' }),
    ]),
  ]);
  assert.equal(byHistory.items[0].login.password, 'current');
  assert.deepEqual(byHistory.items[0].passwordHistory.map((h) => h.password), ['stale']);
});

test('a rename does not make an old password look new; password changes and creation dates decide', () => {
  const { items } = run([
    bwFile([
      bw('https://c.com', 'me', 'from-2020', { creationDate: '2020-01-01T00:00:00.000Z', revisionDate: '2026-09-01T00:00:00.000Z' }),
      bw('https://c.com', 'me', 'changed-2025', {
        creationDate: '2019-01-01T00:00:00.000Z',
        revisionDate: '2025-06-01T00:00:00.000Z',
        passwordHistory: [{ lastUsedDate: '2025-06-01T00:00:00.000Z', password: 'older' }],
      }),
    ]),
  ]);
  assert.equal(items[0].login.password, 'changed-2025');
  assert.deepEqual(items[0].passwordHistory.map((h) => h.password), ['from-2020', 'older']);
});

test('items in the trash are copied as they are', () => {
  const { items, entries } = run([
    bwFile([bw('https://d.com', 'me', 'pw'), bw('https://d.com', 'me', 'pw', { deletedDate: '2026-01-01T00:00:00.000Z' })]),
  ]);
  assert.equal(items.length, 2);
  assert.equal(entries[1].skipReason, 'In the trash');
});

test('a login without a web address is matched by its name when the name is a real domain', () => {
  const { items, analysis, entries } = run([
    bwFile([
      bw('https://apple.com', 'me@x.test', 'pw-a'),
      bw([], 'me@x.test', 'pw-a', { name: 'appleid.apple.com' }),
      bw([], 'other@x.test', 'pw-b', { name: 'idmsa.apple.com' }),
      bw([], 'me@x.test', 'pw-c', { name: 'My Bank' }),
      bw([], 'me@x.test', 'pw-d', { name: 'john.doe' }),
    ]),
    chromeFile([['idmsa.apple.com', 'https://idmsa.apple.com/', 'other@x.test', 'pw-b', '']]),
  ]);
  assert.equal(items.length, 4);
  assert.equal(analysis.groups.length, 2);
  assert.deepEqual(
    entries.map((e) => e.skipReason),
    [null, null, null, 'Logins without a website', 'Logins without a website', null],
  );
  assert.match(analysis.groups[0].removed[0].reason, /its name was used/);
  const apple = items.find((i) => i.login.password === 'pw-a');
  assert.deepEqual(apple.login.uris.map((u) => u.uri), ['https://apple.com', 'https://appleid.apple.com']);
  const idmsa = items.find((i) => i.login.password === 'pw-b');
  assert.deepEqual(idmsa.login.uris.map((u) => u.uri), ['https://idmsa.apple.com/']);
});

test('an unmerged login matched by its name is exported with that name as its web address', () => {
  const { items } = run([bwFile([bw([], 'me', 'pw', { name: 'gujacpc.nic.in' }), bw([], 'me', 'pw2', { name: 'http://aishe.nic.in' }), bw([], 'me', 'pw3', { name: 'AliExpress' })])]);
  assert.deepEqual(items.map((i) => i.login.uris.map((u) => u.uri)), [['https://gujacpc.nic.in'], ['http://aishe.nic.in'], []]);
});

test('a password reset on a real date beats a Chrome copy that only matches an older import', () => {
  const oldImport = { creationDate: '2024-01-27T23:14:06.000Z' };
  const { items } = run([
    bwFile([
      bw('https://www.splitwise.com/authentication', 'me', 'after-reset', { creationDate: '2026-10-05T00:38:36.000Z' }),
      bw([], 'me', 'before-reset', { ...oldImport, name: 'www.splitwise.com' }),
      ...[1, 2, 3, 4].map((n) => bw([], 'me', 'x' + n, { ...oldImport, name: 'filler' + n + '.com' })),
    ]),
    chromeFile([['www.splitwise.com', 'https://www.splitwise.com/login', 'me', 'before-reset', '']]),
  ]);
  const splitwise = items.find((i) => i.login.uris.some((u) => u.uri.includes('splitwise')));
  assert.equal(splitwise.login.password, 'after-reset');
  assert.deepEqual(splitwise.passwordHistory.map((h) => h.password), ['before-reset']);
});

test('Chrome matching only an undated import is not proof, so both entries are kept', () => {
  const imported = (m) => ({ creationDate: `2026-10-12T20:${m}:00.000Z` });
  const { items, analysis } = run([
    bwFile([
      bw([], 'me', 'chrome-copy', { ...imported('14'), name: 'www.paypal.com' }),
      bw('https://www.paypal.com', 'me', 'other', imported('39')),
      ...[1, 2, 3, 4].map((n) => bw([], 'me', 'x' + n, { ...imported('14'), name: 'a' + n + '.com' })),
      ...[1, 2, 3, 4].map((n) => bw([], 'me', 'y' + n, { ...imported('39'), name: 'b' + n + '.com' })),
    ]),
    chromeFile([['www.paypal.com', 'https://www.paypal.com/signin', 'me', 'chrome-copy', '']]),
  ]);
  assert.equal(items.filter((i) => i.login.uris.some((u) => u.uri.includes('paypal'))).length, 2);
  assert.match(analysis.separate.find((s) => s.sites.join().includes('paypal')).reason, /Can't tell/);
});

test('a login without a website joins an entry with the identical name, username and password', () => {
  const { items, entries } = run([
    bwFile([bw([], 'me', 'pw', { name: 'Intuit Credit Karma' }), bw([], 'me', 'other', { name: 'Intuit Credit Karma' })]),
    chromeFile([['Intuit Credit Karma', 'android://abc==@com.creditkarma.mobile/', 'me', 'pw', '']]),
  ]);
  assert.equal(items.length, 2);
  assert.ok(entries[0].twinMatch);
  assert.equal(entries[1].skipReason, 'Logins without a website');
  assert.deepEqual(items.find((i) => i.login.password === 'pw').login.uris.map((u) => u.uri), ['androidapp://com.creditkarma.mobile']);
});

test('different subdomains with different passwords stay separate', () => {
  const { analysis, items } = run([
    bwFile([bw('https://tiktok.com', 'me', 'a'), bw('https://careers.tiktok.com', 'me', 'b')]),
  ]);
  assert.equal(items.length, 2);
  assert.equal(analysis.groups.length, 0);
  assert.match(analysis.separate[0].reason, /subdomains/);
});

test('same credentials on unrelated sites are never merged', () => {
  const { items, analysis } = run([
    bwFile([
      bw('https://github.com', 'me', 'reused'),
      bw('https://gitlab.com', 'me', 'reused'),
      bw('https://foo.github.io', 'me', 'reused'),
      bw('https://bar.github.io', 'me', 'reused'),
      bw('https://a.co.uk', 'me', 'reused'),
      bw('https://b.co.uk', 'me', 'reused'),
    ]),
  ]);
  assert.equal(items.length, 6);
  assert.equal(analysis.groups.length + analysis.separate.length, 0);
});

test('different 2FA secrets or two passkeys block merging', () => {
  const totp = run([
    bwFile([bw('https://x.com', 'me', 'pw', { login: { totp: 'AAAA' } }), bw('https://x.com', 'me', 'pw', { login: { totp: 'BBBB' } })]),
  ]);
  assert.equal(totp.items.length, 2);
  assert.match(totp.analysis.separate[0].reason, /2FA/);

  const passkey = [{ credentialId: '1' }];
  const keys = run([
    bwFile([
      bw('https://y.com', 'me', 'pw', { login: { fido2Credentials: passkey } }),
      bw('https://y.com', 'me', 'pw', { login: { fido2Credentials: [{ credentialId: '2' }] } }),
    ]),
  ]);
  assert.equal(keys.items.length, 2);
  assert.match(keys.analysis.separate[0].reason, /passkey/);
});

test('a single passkey and 2FA code survive the merge even when the other copy is kept', () => {
  const { items } = run([
    bwFile([
      bw('https://z.com', 'me', 'pw', { revisionDate: '2025-01-01T00:00:00.000Z', login: { fido2Credentials: [{ credentialId: 'k' }], totp: 'SECRET' } }),
      bw('https://www.z.com', 'me', 'pw', { revisionDate: '2026-01-01T00:00:00.000Z' }),
    ]),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].login.fido2Credentials[0].credentialId, 'k');
  assert.equal(items[0].login.totp, 'SECRET');
});

test('local addresses and missing usernames only merge exact duplicates', () => {
  const { items, analysis } = run([
    bwFile([
      bw('http://192.168.1.1', 'admin', 'home'),
      bw('http://192.168.1.1', 'admin', 'office'),
      bw('http://192.168.1.1', 'admin', 'office'),
      bw('https://wifi.example.com', '', 'one'),
      bw('https://wifi.example.com', '', 'two'),
    ]),
  ]);
  assert.equal(items.length, 4);
  assert.equal(analysis.groups.length, 1);
  const reasons = analysis.separate.map((s) => s.reason).join(' | ');
  assert.match(reasons, /Local network/);
  assert.match(reasons, /No username/);
});

test('an entry without a password takes the password from its duplicate', () => {
  const { items, analysis } = run([
    bwFile([bw('https://p.com', 'me', null, { login: { fido2Credentials: [{ credentialId: 'pk' }] } })]),
    chromeFile([['p', 'https://p.com', 'me', 'secret', '']]),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].login.password, 'secret');
  assert.equal(items[0].login.fido2Credentials.length, 1);
  assert.match(analysis.groups[0].removed[0].reason, /moved into it/);
});

test('turning off different-password merging still merges exact duplicates', () => {
  const { items } = run(
    [bwFile([bw('https://q.com', 'me', 'a'), bw('https://q.com', 'me', 'b'), bw('https://www.q.com', 'me', 'a')])],
    { mergeDifferentPasswords: false },
  );
  assert.deepEqual(items.map((i) => i.login.password).sort(), ['a', 'b']);
});

test('excluded groups are left untouched', () => {
  const files = [bwFile([bw('https://r.com', 'me', 'pw'), bw('https://r.com', 'me', 'pw')])];
  const first = run(files);
  const { items } = run(files, { mergeDifferentPasswords: true }, new Set([first.analysis.groups[0].id]));
  assert.equal(items.length, 2);
});

test('non-logins, organization items and items without a website pass through unchanged', () => {
  const card = { id: 'c', type: 3, name: 'Visa', card: { number: '4111' } };
  const org = bw('https://s.com', 'me', 'pw', { organizationId: 'org1' });
  const noUri = bw([], 'me', 'pw');
  const { items, entries } = run([bwFile([card, org, bw('https://s.com', 'me', 'pw'), noUri])]);
  assert.equal(items.length, 4);
  assert.deepEqual(
    entries.map((e) => e.skipReason),
    ['Cards', 'Shared organization items', null, 'Logins without a website'],
  );
});

test('usernames compare case-insensitively, passwords compare exactly', () => {
  const same = run([bwFile([bw('https://t.com', 'ME@X.COM', 'pw'), bw('https://t.com', 'me@x.com', 'pw')])]);
  assert.equal(same.items.length, 1);
  const spaced = run([bwFile([bw('https://t.com', 'me@x.com', 'pw '), bw('https://t.com', 'me@x.com', 'pw')])]);
  assert.equal(spaced.analysis.groups.length, 0);
  assert.equal(spaced.items.length, 2);
});

test('csv parsing handles quotes, commas, newlines, CRLF and BOM', () => {
  const text = '﻿name,url,username,password,note\r\n"a, b","https://a.com","u","p""q ","line1\nline2"\r\n';
  const file = parse.parseFile('c.csv', text);
  assert.equal(file.label, 'Chrome');
  const item = file.items[0];
  assert.equal(item.name, 'a, b');
  assert.equal(item.login.password, 'p"q ');
  assert.equal(item.notes, 'line1\nline2');
});

test('rejects encrypted JSON and Bitwarden CSV with a clear message', () => {
  assert.match(parse.parseFile('v.json', '{"encrypted":true,"items":[]}').error, /encrypted/);
  assert.match(parse.parseFile('v.csv', 'folder,favorite,type,name,notes,fields,reprompt,login_uri\n').error, /Bitwarden CSV/);
});

test('output keeps folders and every removed entry is accounted for', () => {
  const folders = [{ id: 'f1', name: 'Work' }];
  const { output, entries } = run([
    bwFile([bw('https://u.com', 'me', 'pw', { folderId: 'f1' }), bw('https://u.com', 'me', 'pw')], folders),
    chromeFile([['u', 'https://u.com', 'me', 'pw', '']]),
  ]);
  assert.deepEqual(output.vault.folders, folders);
  assert.equal(output.vault.items.length + output.removedCount, entries.length);
  assert.equal(output.vault.items[0].folderId, 'f1');
});
