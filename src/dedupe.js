// Finds duplicate logins and merges them without losing data.
// Pass 1: same site + username + password -> exact duplicates.
// Pass 2: same hostname + username, different password -> merged only when the current password is clear;
// the other passwords go to the kept entry's password history.
(function (root) {
  const VD = (root.VD = root.VD || {});
  const SEP = '\u0001';
  const BULK_PER_MINUTE = 5;
  const TYPE_GROUPS = { 2: 'Secure notes', 3: 'Cards', 4: 'Identities', 5: 'SSH keys' };

  // When the current password was set: the newest password-history date marks the last change,
  // otherwise it is unchanged since creation. Rename-only edits don't count.
  function passwordSetTime(item) {
    const changes = (item.passwordHistory || []).map((h) => Date.parse((h && h.lastUsedDate) || '')).filter(Boolean);
    if (changes.length) return { time: Math.max(...changes), fromCreation: false };
    return { time: Date.parse(item.creationDate || item.revisionDate || '') || null, fromCreation: true };
  }

  function skipReasonOf(item, sites) {
    if (item.deletedDate) return 'In the trash';
    if (item.type !== 1) return TYPE_GROUPS[item.type] || 'Other items';
    if (item.organizationId) return 'Shared organization items';
    if (!sites.length) return 'Logins without a website';
    return null;
  }

  function toEntry(item, file, index) {
    const login = item.login || {};
    const uris = (login.uris || []).map((u) => (u && u.uri) || '').filter(Boolean);
    const sites = [];
    for (const uri of uris) {
      const site = VD.site.siteOf(uri);
      if (site && !sites.some((s) => s.key === site.key && s.host === site.host)) sites.push(site);
    }
    const nameSite = !sites.length && item.type === 1 ? VD.site.siteOfName(item.name) : null;
    if (nameSite) sites.push(nameSite);
    const { time, fromCreation } = passwordSetTime(item);
    return {
      uid: 'e' + index,
      item,
      source: file.label,
      fileName: file.fileName,
      fromCsv: file.kind === 'csv',
      name: item.name || '',
      username: login.username || '',
      userKey: (login.username || '').trim().toLowerCase(),
      password: login.password || '',
      totp: (login.totp || '').trim(),
      hasPasskey: (login.fido2Credentials || []).length > 0,
      time: file.kind === 'csv' ? null : time,
      fromCreation,
      bulkDate: null,
      uris,
      sites,
      siteFromName: !!nameSite,
      skipReason: skipReasonOf(item, sites),
    };
  }

  function prepare(files) {
    const entries = [];
    for (const file of files) for (const item of file.items) entries.push(toEntry(item, file, entries.length));

    // An import stamps every item with the import time, so those dates say nothing about the password.
    const minuteOf = (e) => new Date(e.time).toISOString().slice(0, 16);
    const perMinute = new Map();
    const dated = entries.filter((e) => e.time && e.fromCreation);
    for (const e of dated) perMinute.set(minuteOf(e), (perMinute.get(minuteOf(e)) || 0) + 1);
    for (const e of dated) {
      if (perMinute.get(minuteOf(e)) >= BULK_PER_MINUTE) {
        e.bulkDate = e.time;
        e.time = null;
      }
    }

    // A login with no usable website joins an entry with the identical name, username and password.
    const twinKey = (e) => [e.name.trim().toLowerCase(), e.userKey, e.password].join(SEP);
    const sitesByTwin = new Map();
    for (const e of entries) {
      if (e.skipReason || !e.password) continue;
      if (!sitesByTwin.has(twinKey(e))) sitesByTwin.set(twinKey(e), []);
      sitesByTwin.get(twinKey(e)).push(...e.sites);
    }
    for (const e of entries) {
      const twinSites = e.skipReason === 'Logins without a website' && e.password && sitesByTwin.get(twinKey(e));
      if (!twinSites || !twinSites.length) continue;
      e.sites = uniqueBy(twinSites, (s) => s.key + SEP + s.host);
      e.twinMatch = true;
      e.skipReason = null;
    }
    return entries;
  }

  // Union-find: nodes sharing any key end up in the same component.
  function components(nodes, keysOf) {
    const parent = nodes.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const owner = new Map();
    nodes.forEach((node, i) => {
      for (const key of keysOf(node)) {
        if (owner.has(key)) parent[find(i)] = find(owner.get(key));
        else owner.set(key, i);
      }
    });
    const groups = new Map();
    nodes.forEach((node, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(node);
    });
    return [...groups.values()];
  }

  const hostsOf = (entries) => [...new Set(entries.flatMap((e) => e.sites.map(VD.site.displayName)))];

  function lockReason(entries) {
    if (new Set(entries.map((e) => e.totp).filter(Boolean)).size > 1) return 'They have different 2FA codes';
    if (entries.filter((e) => e.hasPasskey).length > 1) return 'More than one of them has a passkey';
    return null;
  }

  const inHistory = (entry, password) =>
    !!password && (entry.item.passwordHistory || []).some((h) => h && h.password === password);

  const holders = (entries, password) => entries.filter((e) => e.password === password);
  const setTime = (entries, password) => Math.max(0, ...holders(entries, password).map((e) => e.time || 0));
  // Latest moment the password is known to have existed: its set date, else the earliest import that carried it.
  function existedBy(entries, password) {
    const set = setTime(entries, password);
    if (set) return set;
    const imports = holders(entries, password).map((e) => e.bulkDate).filter(Boolean);
    return imports.length ? Math.min(...imports) : null;
  }

  // Which password is current, or null when the evidence doesn't settle it.
  function pickPassword(entries) {
    const withPw = entries.filter((e) => e.password);
    const candidates = [...new Set(withPw.map((e) => e.password))];
    if (candidates.length < 2) return { password: candidates[0] || '', why: null };

    let left = candidates.filter((p) => !withPw.some((e) => e.password !== p && inHistory(e, p)));
    if (left.length === 1) return { password: left[0], why: 'history' };
    if (!left.length) left = candidates;

    for (const p of left) {
      const t = setTime(withPw, p);
      const newest = t && left.every((q) => q === p || (existedBy(withPw, q) !== null && existedBy(withPw, q) < t));
      if (newest) return { password: p, why: 'dates' };
    }

    // A bulk-imported Bitwarden copy may itself be a copy of Chrome, so only a dated one confirms Chrome.
    const confirmed = left.filter((p) => {
      const h = holders(withPw, p);
      return h.some((e) => e.fromCsv) && h.some((e) => !e.fromCsv && e.time);
    });
    if (confirmed.length === 1) return { password: confirmed[0], why: 'agreement' };
    return null;
  }

  // The entry whose name, folder and settings carry over: Bitwarden first, then the richest one.
  function pickKept(entries, password) {
    const eligible = entries.filter((e) => !e.password || e.password === password);
    return (eligible.length ? eligible : entries)
      .map((e, order) => ({ e, order }))
      .sort(
        (a, b) =>
          a.e.fromCsv - b.e.fromCsv ||
          b.e.hasPasskey - a.e.hasPasskey ||
          !!b.e.totp - !!a.e.totp ||
          !!b.e.password - !!a.e.password ||
          (b.e.time || 0) - (a.e.time || 0) ||
          b.e.uris.length - a.e.uris.length ||
          a.order - b.order,
      )[0].e;
  }

  const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

  function removalReason(group, e) {
    const { kept, keptPassword, why, all } = group;
    if (!e.password) return 'Same account, but this copy had no password saved';
    if (e.password === keptPassword && !kept.password) return 'Same account: the kept entry had no password, so this password was moved into it';
    if (e.password === keptPassword) {
      const byName = [e, kept].some((x) => x.siteFromName || x.twinMatch) ? ' (one has no web address saved, so its name was used)' : '';
      return `Exact duplicate: same site, username and password${byName}`;
    }
    const listedAsOld = all.some((o) => o.password !== e.password && inHistory(o, e.password));
    const because = {
      history: 'another copy of this login lists it as an old password',
      dates: `the kept password was set on ${fmtDate(setTime(all, keptPassword))}, and this one already existed by ${fmtDate(existedBy(all, e.password))}`,
      agreement: 'the kept password is in Chrome and in a dated Bitwarden entry, so it is treated as current',
    }[listedAsOld ? 'history' : why];
    return `Older password: ${because}. It is saved in the kept entry's password history`;
  }

  function makeGroup(entries, decision) {
    const kept = pickKept(entries, decision.password);
    const group = {
      id: entries.map((e) => e.uid).sort().join('+'),
      kind: decision.why ? 'older' : 'exact',
      kept,
      keptPassword: decision.password,
      why: decision.why,
      all: entries,
      sites: hostsOf(entries),
      username: kept.username || entries.map((e) => e.username).find(Boolean) || '',
    };
    group.removed = entries.filter((e) => e !== kept).map((e) => ({ entry: e, reason: removalReason(group, e) }));
    return group;
  }

  function separateReason(entries, settings, undecided) {
    const lock = lockReason(entries);
    if (lock) return lock;
    if (!entries.some((e) => e.userKey)) return 'No username saved, so they could be different accounts';
    if (entries.some((e) => e.sites.some((s) => s.local))) return 'Local network address: different devices often share one';
    if (entries.some((e) => undecided.has(e.uid))) {
      return "Can't tell which password is current: no reliable dates, and Chrome and Bitwarden don't agree. Both are kept, so use the one that works and delete the other in Bitwarden";
    }
    if (!settings.mergeDifferentPasswords) return 'Different passwords, and merging those is turned off';
    return 'Different subdomains with different passwords: these are often separate systems';
  }

  function analyze(entries, settings) {
    const eligible = entries.filter((e) => !e.skipReason);
    const exact = components(eligible, (e) => e.sites.map((s) => s.key + SEP + e.userKey + SEP + e.password));
    let units = [];
    for (const comp of exact) {
      if (comp.length > 1 && !lockReason(comp)) units.push(comp);
      else units.push(...comp.map((e) => [e]));
    }

    const decisions = new Map();
    const undecided = new Set();
    if (settings.mergeDifferentPasswords) {
      const hostKeys = (unit) =>
        unit.flatMap((e) => (e.userKey ? e.sites.filter((s) => !s.local).map((s) => s.host + SEP + e.userKey) : []));
      const merged = [];
      for (const comp of components(units, hostKeys)) {
        const all = comp.flat();
        const decision = comp.length > 1 && !lockReason(all) ? pickPassword(all) : null;
        if (decision) {
          merged.push(all);
          decisions.set(all, decision);
        } else {
          if (comp.length > 1) all.forEach((e) => undecided.add(e.uid));
          merged.push(...comp);
        }
      }
      units = merged;
    }

    const groups = units.filter((u) => u.length > 1).map((u) => makeGroup(u, decisions.get(u) || pickPassword(u)));

    // Lookalikes left unmerged: same site + username across different units.
    const separate = [];
    const siteKeys = (unit) => unit.flatMap((e) => e.sites.map((s) => s.key + SEP + e.userKey));
    for (const comp of components(units, siteKeys)) {
      if (comp.length < 2) continue;
      const all = comp.flat();
      separate.push({
        id: 's:' + all.map((e) => e.uid).sort().join('+'),
        units: comp.map((u) => ({ entry: pickKept(u, (decisions.get(u) || pickPassword(u) || {}).password), count: u.length })),
        reason: separateReason(all, settings, undecided),
        sites: hostsOf(all),
        username: all.map((e) => e.username).find(Boolean) || '',
      });
    }

    return { groups, separate };
  }

  function uniqueBy(list, keyOf) {
    const seen = new Set();
    return list.filter((x) => {
      const k = keyOf(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // A login matched by its name gets that name saved as its web address, so autofill works after import.
  const nameUris = (entries) =>
    entries.filter((e) => e.siteFromName).map((e) => ({ match: null, uri: /^https?:\/\//i.test(e.name.trim()) ? e.name.trim() : 'https://' + e.name.trim() }));

  function withNameUri(entry) {
    const out = structuredClone(entry.item);
    out.login = { ...out.login, uris: nameUris([entry]) };
    return out;
  }

  function mergeItems(group) {
    const kept = group.kept;
    const others = group.removed.map((r) => r.entry);
    const all = [kept, ...others];
    const out = structuredClone(kept.item);
    const login = (out.login = out.login || {});

    login.uris = uniqueBy(
      [...all.flatMap((e) => (e.item.login && e.item.login.uris) || []).filter((u) => u && u.uri), ...nameUris(all)],
      (u) => u.uri.trim().replace(/\/+$/, ''),
    ).map((u) => structuredClone(u));
    login.password = group.keptPassword || null;
    login.totp = kept.totp || (others.find((e) => e.totp) || {}).totp || null;
    if (!(login.fido2Credentials || []).length) {
      const donor = others.find((e) => e.hasPasskey);
      if (donor) login.fido2Credentials = structuredClone(donor.item.login.fido2Credentials);
    }
    if (!login.username) login.username = group.username || null;

    const notes = [...new Set(all.map((e) => (e.item.notes || '').trim()).filter(Boolean))];
    out.notes = notes.length ? notes.join('\n\n') : null;
    const fields = all.flatMap((e) => e.item.fields || []);
    out.fields = fields.length ? uniqueBy(fields, (f) => JSON.stringify([f.name, f.value, f.type, f.linkedId])) : out.fields;

    const now = new Date().toISOString();
    const history = [];
    for (const e of all) for (const h of e.item.passwordHistory || []) if (h && h.password) history.push(h);
    for (const e of others) if (e.password) history.push({ lastUsedDate: e.item.revisionDate || now, password: e.password });
    const cleanHistory = uniqueBy(
      history.filter((h) => h.password !== login.password),
      (h) => h.password,
    ).sort((a, b) => (Date.parse(b.lastUsedDate) || 0) - (Date.parse(a.lastUsedDate) || 0));
    if (cleanHistory.length) out.passwordHistory = cleanHistory;

    out.name = kept.name || all.map((e) => e.name).find(Boolean) || '';
    out.favorite = all.some((e) => e.item.favorite);
    out.reprompt = Math.max(...all.map((e) => e.item.reprompt || 0));
    if (!out.folderId) out.folderId = (others.find((e) => e.item.folderId) || { item: {} }).item.folderId || null;
    const created = all.map((e) => e.item.creationDate).filter(Boolean).sort();
    if (created.length) out.creationDate = created[0];
    return out;
  }

  function buildOutput(files, entries, analysis, excluded) {
    const replaced = new Map();
    const removed = new Set();
    for (const g of analysis.groups) {
      if (excluded.has(g.id)) continue;
      replaced.set(g.kept.uid, { item: mergeItems(g), group: g });
      for (const r of g.removed) removed.add(r.entry.uid);
    }
    const rows = entries
      .filter((e) => !removed.has(e.uid))
      .map((e) => {
        if (replaced.has(e.uid)) return { entry: e, ...replaced.get(e.uid) };
        return { entry: e, item: e.siteFromName ? withNameUri(e) : e.item, group: null };
      });
    const folders = uniqueBy(
      files.flatMap((f) => f.folders || []),
      (f) => f.id,
    );
    return { vault: { encrypted: false, folders, items: rows.map((r) => r.item) }, rows, removedCount: removed.size };
  }

  VD.dedupe = { prepare, analyze, buildOutput, mergeItems };
})(globalThis);
