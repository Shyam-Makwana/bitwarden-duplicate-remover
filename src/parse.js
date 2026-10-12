// Reads a Bitwarden JSON export or a browser CSV export into Bitwarden-shaped items.
(function (root) {
  const VD = (root.VD = root.VD || {});

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c !== '"') field += c;
        else if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += c;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((v) => v.trim() !== ''));
  }

  const COLUMNS = {
    name: ['name', 'title'],
    url: ['url', 'website', 'login_url'],
    username: ['username', 'login', 'user name'],
    password: ['password'],
    notes: ['note', 'notes', 'comments'],
    totp: ['otpauth', 'totp'],
  };

  function csvLabel(headers) {
    if (headers.includes('httprealm')) return 'Firefox';
    if (headers.includes('title') && headers.includes('otpauth')) return 'Safari';
    if (headers.join(',').startsWith('name,url,username,password')) return 'Chrome';
    return 'CSV';
  }

  function fromCsv(text) {
    const [header, ...rows] = parseCsv(text);
    if (!header) return { error: 'This file is empty' };
    const headers = header.map((h) => h.trim().toLowerCase());
    if (headers.includes('login_uri')) {
      return {
        error:
          'This is a Bitwarden CSV export. Export Bitwarden as .json instead: CSV leaves out passkeys, cards, identities and password history',
      };
    }
    const col = {};
    for (const [key, names] of Object.entries(COLUMNS)) col[key] = headers.findIndex((h) => names.includes(h));
    if (col.url < 0 || col.password < 0) {
      return { error: 'No url and password columns found. Use a Bitwarden .json or a browser password .csv export' };
    }
    const get = (r, key) => (col[key] >= 0 ? (r[col[key]] || '').trim() : '');
    const items = rows.map((r) => {
      // Same conversion Bitwarden's own Chrome importer does, so mobile autofill keeps working.
      const url = get(r, 'url').replace(/^android:\/\/[^@]*@([^/?#]+)\/?$/i, 'androidapp://$1');
      const site = url ? VD.site.siteOf(url) : null;
      return {
        type: 1,
        name: get(r, 'name') || (site ? VD.site.displayName(site).replace(/ \(app\)$/, '') : url),
        notes: (col.notes >= 0 ? r[col.notes] || '' : '') || null,
        favorite: false,
        reprompt: 0,
        folderId: null,
        organizationId: null,
        collectionIds: null,
        fields: [],
        login: {
          uris: url ? [{ match: null, uri: url }] : [],
          username: get(r, 'username') || null,
          // Passwords are taken verbatim: leading/trailing spaces can be part of a password.
          password: (col.password >= 0 ? r[col.password] : '') || null,
          totp: get(r, 'totp') || null,
        },
      };
    });
    return { label: csvLabel(headers), kind: 'csv', items, folders: [] };
  }

  function fromBitwardenJson(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { error: 'This file is not valid JSON' };
    }
    if (data.encrypted) {
      return {
        error: 'This Bitwarden export is encrypted. Export again and pick the ".json" format, not ".json (Encrypted)"',
      };
    }
    if (!Array.isArray(data.items)) return { error: 'No vault items found in this file' };
    return { label: 'Bitwarden', kind: 'bitwarden', items: data.items, folders: data.folders || [] };
  }

  function parseFile(fileName, text) {
    const clean = text.replace(/^﻿/, '');
    const isJson = /\.json$/i.test(fileName) || clean.trimStart().startsWith('{');
    const result = isJson ? fromBitwardenJson(clean) : fromCsv(clean);
    return { fileName, ...result };
  }

  VD.parse = { parseFile, parseCsv };
})(globalThis);
