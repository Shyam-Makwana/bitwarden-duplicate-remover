// End-to-end check on ~2,000 generated entries with planted duplicates: counts match the plan
// and nothing (password, web address, 2FA, passkey, note, field) is lost in the output.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/psl-data.js');
require('../src/site.js');
require('../src/parse.js');
require('../src/dedupe.js');
const { parse, dedupe, site } = globalThis.VD;

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function buildFixture() {
  const rand = rng(42);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const day = (n, minutes = 0) => new Date(Date.UTC(2019, 0, 1) + n * 86400000 + minutes * 60000).toISOString();
  const imported = '2026-10-12T09:15:00.000Z';
  const tlds = ['com', 'net', 'org', 'io', 'co.uk', 'com.au', 'de'];
  const users = ['alex@example.test', 'Alex@Example.test', 'alex.k', 'akumar', 'alex+shop@example.test'];
  const bw = [];
  const chrome = [];
  const expect = { exact: 0, older: 0, separate: 0 };
  let n = 0;
  const item = (domain, username, password, extra = {}) => ({
    id: 'id-' + ++n,
    type: 1,
    name: extra.name || domain,
    notes: extra.notes ?? null,
    favorite: false,
    reprompt: 0,
    folderId: null,
    organizationId: null,
    collectionIds: null,
    fields: extra.fields || [],
    creationDate: extra.createdAt || day(Math.floor(rand() * 2000)),
    revisionDate: day(2100),
    passwordHistory: null,
    login: {
      uris: [{ match: null, uri: extra.uri || 'https://' + domain }],
      username,
      password,
      totp: extra.totp || null,
      fido2Credentials: extra.passkey ? [{ credentialId: 'pk-' + n }] : [],
    },
  });

  for (let i = 0; i < 1000; i++) {
    const domain = `site${i}.${pick(tlds)}`;
    const username = pick(users);
    const password = `P${i}-${Math.floor(rand() * 1e9)}`;
    const roll = rand();
    const extra = {
      totp: roll < 0.15 ? 'TOTP' + i : null,
      passkey: roll > 0.92,
      notes: roll > 0.5 && roll < 0.6 ? 'note ' + i : null,
      fields: roll > 0.8 && roll < 0.85 ? [{ name: 'pin', value: String(i), type: 1 }] : [],
      createdAt: day(1000, i),
    };
    const main = item(domain, username, password, extra);
    bw.push(main);

    if (i < 100) {
      bw.push(item('www.' + domain, username, password, { notes: 'dup note ' + i, createdAt: imported }));
      expect.exact++;
    }
    if (i < 500) {
      chrome.push([domain, pick(['https://www.', 'https://', 'https://login.']) + domain + '/', username.toUpperCase(), password, '']);
      expect.exact++;
    }
    // Chrome agrees with the main entry; a stale copy imported in bulk has no usable date.
    if (i >= 500 && i < 530) {
      chrome.push([domain, 'https://www.' + domain + '/', username, password, '']);
      bw.push(item(domain, username, 'stale-' + password, { createdAt: imported }));
      expect.older += 2;
    }
    // Chrome disagrees and nothing else tells: both kept.
    if (i >= 530 && i < 560) {
      chrome.push([domain, 'https://www.' + domain + '/', username, 'other-' + password, '']);
      expect.separate++;
    }
    if (i >= 560 && i < 600) {
      bw.push(item(domain, username, 'older-' + password, { createdAt: day(200, i) }));
      expect.older++;
    }
    if (i >= 600 && i < 630) {
      bw.push(item('careers.' + domain, username, 'careers-' + password));
      expect.separate++;
    }
    if (i >= 630 && i < 640 && !extra.passkey) {
      main.login.totp = 'TOTP' + i;
      bw.push(item(domain, username, password, { totp: 'OTHER' + i }));
      expect.separate++;
    }
    if (i >= 640 && i < 690) {
      bw.push(item(`reuse${i}.${pick(tlds)}`, username, password));
    }
  }
  for (let r = 0; r < 5; r++) {
    bw.push(item('192.168.1.1', 'admin', 'router-a' + r, { uri: `http://192.168.1.1:${8000 + r}` }));
    bw.push(item('192.168.1.1', 'admin', 'router-b' + r, { uri: `http://192.168.1.1:${8000 + r}` }));
    expect.separate++;
  }
  for (let c = 0; c < 20; c++) bw.push({ id: 'card' + c, type: 3, name: 'Card ' + c, card: { number: '4111' + c } });
  for (let c = 0; c < 250; c++) chrome.push([`only${c}.com`, `https://only${c}.com/login`, 'alex', 'solo' + c, c % 10 ? '' : 'note,\n"multi"']);

  const csv = ['name,url,username,password,note', ...chrome.map((r) => r.map((v) => '"' + v.replace(/"/g, '""') + '"').join(','))].join('\n');
  return { bwText: JSON.stringify({ encrypted: false, folders: [], items: bw }), csv, expect };
}

test('2,000-entry run: planted duplicates are found and nothing is lost', () => {
  const { bwText, csv, expect } = buildFixture();
  const files = [parse.parseFile('vault.json', bwText), parse.parseFile('Chrome Passwords.csv', csv)];
  const started = Date.now();
  const entries = dedupe.prepare(files);
  const analysis = dedupe.analyze(entries, { mergeDifferentPasswords: true });
  const { vault, removedCount } = dedupe.buildOutput(files, entries, analysis, new Set());
  const elapsed = Date.now() - started;

  const removedOf = (kind) => analysis.groups.filter((g) => g.kind === kind).reduce((s, g) => s + g.removed.length, 0);
  const total = removedOf('exact') + removedOf('older');
  assert.ok(entries.length > 1900, `generated ${entries.length} entries`);
  assert.equal(total, expect.exact + expect.older, 'removed count matches the planted duplicates');
  assert.equal(analysis.separate.length, expect.separate, 'lookalikes kept separately');
  assert.equal(vault.items.length + removedCount, entries.length, 'every entry accounted for');
  assert.ok(elapsed < 3000, `ran in ${elapsed}ms`);

  const out = vault.items.filter((i) => i.type === 1);
  const has = (pred) => out.some(pred);
  for (const e of entries) {
    const login = e.item.login;
    if (!login) {
      assert.ok(vault.items.includes(e.item), 'non-login item copied as is');
      continue;
    }
    const pw = login.password;
    if (pw) {
      assert.ok(
        has((i) => i.login.password === pw || (i.passwordHistory || []).some((h) => h.password === pw)),
        `password of ${e.name} survives`,
      );
    }
    const bare = (uri) => uri.trim().replace(/\/+$/, '');
    for (const u of login.uris) assert.ok(has((i) => i.login.uris.some((x) => bare(x.uri) === bare(u.uri))), `uri ${u.uri} survives`);
    if (e.totp) assert.ok(has((i) => i.login.totp === e.totp), `2FA of ${e.name} survives`);
    for (const k of login.fido2Credentials || []) {
      assert.ok(has((i) => (i.login.fido2Credentials || []).some((x) => x.credentialId === k.credentialId)), 'passkey survives');
    }
    if (e.item.notes) assert.ok(has((i) => (i.notes || '').includes(e.item.notes)), `note of ${e.name} survives`);
    for (const f of e.item.fields || []) assert.ok(has((i) => (i.fields || []).some((x) => x.value === f.value)), 'field survives');
  }

  // No remaining pair shares site + username + password unless a 2FA/passkey conflict kept them apart.
  const seen = new Map();
  for (const i of out) {
    for (const u of i.login.uris) {
      const key = [site.siteOf(u.uri).key, (i.login.username || '').toLowerCase(), i.login.password].join('|');
      if (seen.has(key) && seen.get(key) !== i) {
        assert.ok(i.login.totp && seen.get(key).login.totp && i.login.totp !== seen.get(key).login.totp, `leftover duplicate ${key}`);
      }
      seen.set(key, i);
    }
  }

  // Reused passwords on different websites are never merged.
  for (const g of analysis.groups) {
    const domains = new Set([g.kept, ...g.removed.map((r) => r.entry)].flatMap((e) => e.sites.map((s) => s.key)));
    assert.equal(domains.size, 1, `group ${g.sites} spans one website`);
  }
});
