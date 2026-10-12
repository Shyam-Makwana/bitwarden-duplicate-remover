// HTML builders for the app views. Every vault value goes through esc().
(function (root) {
  const VD = (root.VD = root.VD || {});

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (n) => n.toLocaleString('en-US');
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

  // Non-reversible colour + code so equal passwords can be compared without showing them.
  function fingerprint(password) {
    let h = 0x811c9dc5;
    for (let i = 0; i < password.length; i++) h = Math.imul(h ^ password.charCodeAt(i), 0x01000193) >>> 0;
    return { hue: h % 360, code: (h >>> 16).toString(16).padStart(4, '0') };
  }

  function passwordCell(uid, password, revealed) {
    if (password === null) return '<span class="pw"></span>';
    if (!password) return '<span class="pw none">No password</span>';
    const fp = fingerprint(password);
    const shown = revealed.has(uid);
    return (
      `<span class="pw"><span class="swatch" data-hue="${fp.hue}" title="Same colour and code = same password"></span>` +
      `<code>${fp.code}</code>` +
      `<button type="button" class="link" data-action="reveal" data-uid="${uid}" aria-pressed="${shown}">${shown ? 'Hide' : 'Show'}</button>` +
      (shown ? `<code class="secret">${esc(password)}</code>` : '') +
      '</span>'
    );
  }

  const hostsOf = (entry) => [...new Set(entry.sites.map(VD.site.displayName))];

  function tags(entry) {
    const item = entry.item;
    const list = [];
    if (entry.totp) list.push('2FA');
    if (entry.hasPasskey) list.push('Passkey');
    if ((item.notes || '').trim()) list.push('Notes');
    if ((item.fields || []).length) list.push('Fields');
    if ((item.passwordHistory || []).length) list.push('History');
    return list.map((t) => `<span class="tag">${t}</span>`).join('');
  }

  const TYPE_NAMES = { 1: 'Login', 2: 'Secure note', 3: 'Card', 4: 'Identity', 5: 'SSH key' };
  const day = (t) => new Date(t).toISOString().slice(0, 10);

  function dateCell(e) {
    if (e.item.type !== 1) return '<span class="date"></span>';
    if (e.time) return `<span class="date" title="When this password was set">${day(e.time)}</span>`;
    if (e.bulkDate) {
      return `<span class="date" title="Created by a bulk import on ${day(e.bulkDate)}, so this date says nothing about the password">Imported</span>`;
    }
    return `<span class="date">${e.fromCsv ? 'No date' : ''}</span>`;
  }

  function entryRow(entry, { state, label, password, reason, note }, revealed) {
    const hosts = hostsOf(entry);
    return `
      <div class="row ${state}">
        <span class="state">${label}</span>
        <span class="src" title="${esc(entry.fileName)}">${esc(entry.source)}</span>
        <span class="name">${esc(entry.name) || '<em>Untitled</em>'}${note ? `<span class="note">${note}</span>` : ''}</span>
        <span class="hosts" title="${esc(entry.uris.join('\n'))}">${esc(hosts.join(', '))}${entry.siteFromName ? '<span class="note">no web address saved: matched by its name, which is added as its web address</span>' : entry.twinMatch ? '<span class="note">no web address saved: matched to an entry with the same name, username and password</span>' : ''}</span>
        ${passwordCell(entry.uid, password, revealed)}
        <span class="tags">${tags(entry)}</span>
        ${dateCell(entry)}
        ${reason ? `<p class="why">${esc(reason)}</p>` : ''}
      </div>`;
  }

  function groupHead(sites, username, side) {
    return `
      <header class="ghead">
        <h3><span class="site">${esc(sites.join(', '))}</span><span class="user">${esc(username) || 'No username'}</span></h3>
        ${side}
      </header>`;
  }

  function mergeGroup(g, excluded, revealed) {
    const off = excluded.has(g.id);
    const total = g.removed.length + 1;
    const side = `
      <p class="count">${off ? `Left as ${total} separate entries` : `${total} entries become 1`}</p>
      <label class="merge-toggle"><input type="checkbox" data-action="exclude" data-id="${esc(g.id)}" ${off ? '' : 'checked'}> Merge</label>`;
    const kept = entryRow(g.kept, { state: 'kept', label: off ? 'Unchanged' : 'Kept', password: off ? g.kept.password : g.keptPassword }, revealed);
    const removed = g.removed
      .map((r) => entryRow(r.entry, { state: off ? 'kept' : 'removed', label: off ? 'Unchanged' : 'Removed', password: r.entry.password, reason: off ? '' : r.reason }, revealed))
      .join('');
    return `<article class="group ${off ? 'is-off' : ''} kind-${g.kind}">${groupHead(g.sites, g.username, side)}${kept}${removed}</article>`;
  }

  function separateGroup(s, revealed) {
    const rows = s.units
      .map((u) => entryRow(u.entry, { state: 'kept', label: 'Kept', password: u.entry.password, note: u.count > 1 ? `plus ${plural(u.count - 1, 'duplicate', 'duplicates')} merged in` : '' }, revealed))
      .join('');
    return `<article class="group kind-separate">${groupHead(s.sites, s.username, `<p class="count">${s.units.length} entries kept</p>`)}<p class="reason">${esc(s.reason)}</p>${rows}</article>`;
  }

  function vaultRow(r, revealed) {
    const merged = r.group ? r.group.removed.length : 0;
    return entryRow(
      r.entry,
      {
        state: merged ? 'kept' : 'plain',
        label: r.entry.skipReason ? 'As is' : merged ? 'Merged' : 'Unique',
        password: r.group ? r.group.keptPassword : r.entry.password,
        note: merged ? `${plural(merged, 'duplicate', 'duplicates')} merged in` : r.entry.skipReason ? esc(r.entry.skipReason) : '',
      },
      revealed,
    );
  }

  function asIsRow(entry, revealed) {
    const isLogin = entry.item.type === 1;
    return entryRow(
      entry,
      {
        state: 'plain',
        label: TYPE_NAMES[entry.item.type] || 'Item',
        password: isLogin ? entry.password : null,
        note: isLogin || entry.item.deletedDate ? esc(entry.skipReason) : '',
      },
      revealed,
    );
  }

  function more(shown, total) {
    if (shown >= total) return '';
    return `<button type="button" class="more" data-action="more">Show ${num(Math.min(100, total - shown))} more of ${num(total - shown)} left</button>`;
  }

  function empty(text) {
    return `<p class="empty">${text}</p>`;
  }

  VD.render = { esc, num, plural, mergeGroup, separateGroup, vaultRow, asIsRow, more, empty, hostsOf };
})(globalThis);
