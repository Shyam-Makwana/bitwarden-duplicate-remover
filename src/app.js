(function (root) {
  const { parse, dedupe, render: R } = root.VD;
  const $ = (id) => document.getElementById(id);
  const PAGE = 100;
  const CAT_WORDS = {
    Cards: ['card', 'cards'],
    'Secure notes': ['secure note', 'secure notes'],
    Identities: ['identity', 'identities'],
    'SSH keys': ['SSH key', 'SSH keys'],
    'Other items': ['other item', 'other items'],
    'Shared organization items': ['shared organization item', 'shared organization items'],
    'Logins without a website': ['login without a website', 'logins without a website'],
    'In the trash': ['in the trash', 'in the trash'],
  };

  const state = {
    files: [],
    entries: [],
    analysis: { groups: [], separate: [] },
    output: null,
    excluded: new Set(),
    settings: { mergeDifferentPasswords: true },
    tab: 'removed',
    kind: 'all',
    cat: 'all',
    query: '',
    limit: PAGE,
    revealed: new Set(),
  };

  function recompute() {
    state.entries = dedupe.prepare(state.files);
    state.analysis = dedupe.analyze(state.entries, state.settings);
    const ids = new Set(state.analysis.groups.map((g) => g.id));
    state.excluded = new Set([...state.excluded].filter((id) => ids.has(id)));
    state.output = dedupe.buildOutput(state.files, state.entries, state.analysis, state.excluded);
    render();
  }

  function counts() {
    const active = state.analysis.groups.filter((g) => !state.excluded.has(g.id));
    const removedOf = (kind) => active.filter((g) => g.kind === kind).reduce((n, g) => n + g.removed.length, 0);
    const asIsByCat = new Map();
    for (const e of state.entries) if (e.skipReason) asIsByCat.set(e.skipReason, (asIsByCat.get(e.skipReason) || 0) + 1);
    return {
      asIsByCat,
      in: state.entries.length,
      removed: state.output.removedCount,
      out: state.output.vault.items.length,
      exact: removedOf('exact'),
      older: removedOf('older'),
      separate: state.analysis.separate.length,
      asIs: state.entries.filter((e) => e.skipReason).length,
      groups: state.analysis.groups.length,
    };
  }

  const matches = (entries) => {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return entries.some((e) =>
      [e.name, e.username, ...e.uris].some((v) => (v || '').toLowerCase().includes(q)),
    );
  };

  function renderFiles() {
    $('fileList').innerHTML = state.files
      .map(
        (f, i) => `
        <li><span class="fname">${R.esc(f.fileName)}</span>
        <span class="fmeta">${R.esc(f.label)} export, ${R.plural(f.items.length, 'entry', 'entries')}</span>
        <button type="button" class="link" data-action="remove-file" data-index="${i}">Remove</button></li>`,
      )
      .join('');
  }

  function renderLedger(c) {
    $('figIn').textContent = R.num(c.in);
    $('figRemoved').textContent = R.num(c.removed);
    $('figOut').textContent = R.num(c.out);
    const parts = [
      `${R.plural(c.exact, 'exact duplicate', 'exact duplicates')} and ${R.plural(c.older, 'entry', 'entries')} with an older password removed.`,
    ];
    if (c.separate) parts.push(`${R.plural(c.separate, 'lookalike group', 'lookalike groups')} kept separately on purpose.`);
    if (c.asIs) {
      const cats = [...c.asIsByCat].sort((a, b) => b[1] - a[1]).map(([cat, n]) => R.plural(n, ...(CAT_WORDS[cat] || [cat, cat])));
      parts.push(`${R.num(c.asIs)} copied as they are: ${cats.join(', ')}.`);
    }
    $('ledgerNote').textContent = parts.join(' ');
    $('mergeDifferent').checked = state.settings.mergeDifferentPasswords;
  }

  function renderTabs(c) {
    const labels = {
      removed: `Removed ${R.num(c.removed)}`,
      separate: `Kept separately ${R.num(c.separate)}`,
      asis: `Copied as is ${R.num(c.asIs)}`,
      vault: `New vault ${R.num(c.out)}`,
      rules: 'How it decides',
    };
    for (const btn of document.querySelectorAll('[data-tab]')) {
      btn.textContent = labels[btn.dataset.tab];
      btn.setAttribute('aria-selected', String(btn.dataset.tab === state.tab));
    }
    $('kindFilter').hidden = state.tab !== 'removed';
    $('catFilter').hidden = state.tab !== 'asis';
    $('searchBar').hidden = state.tab === 'rules';
    const groupsOf = (kind) => state.analysis.groups.filter((g) => kind === 'all' || g.kind === kind).length;
    const removedOf = { all: c.removed, exact: c.exact, older: c.older };
    for (const btn of document.querySelectorAll('[data-kind]')) {
      const kind = btn.dataset.kind;
      btn.querySelector('.n').textContent = `${R.num(removedOf[kind])} removed in ${R.plural(groupsOf(kind), 'group', 'groups')}`;
      btn.setAttribute('aria-pressed', String(kind === state.kind));
    }
    const cats = [['all', c.asIs], ...[...c.asIsByCat].sort((a, b) => b[1] - a[1])];
    $('catFilter').innerHTML = cats
      .map(([cat, n]) => `<button type="button" data-cat="${R.esc(cat)}" aria-pressed="${cat === state.cat}">${cat === 'all' ? 'All' : R.esc(cat)} <span class="n">${R.num(n)}</span></button>`)
      .join('');
  }

  function renderView() {
    const view = $('view');
    $('rules').hidden = state.tab !== 'rules';
    if (state.tab === 'rules') {
      view.innerHTML = '';
      return;
    }
    let html;
    if (state.tab === 'removed') {
      const list = state.analysis.groups.filter(
        (g) => (state.kind === 'all' || g.kind === state.kind) && matches([g.kept, ...g.removed.map((r) => r.entry)]),
      );
      html = list.length
        ? list.slice(0, state.limit).map((g) => R.mergeGroup(g, state.excluded, state.revealed)).join('') + R.more(state.limit, list.length)
        : R.empty(state.query ? 'No duplicates match your search.' : 'No duplicates found.');
    } else if (state.tab === 'separate') {
      const list = state.analysis.separate.filter((s) => matches(s.units.map((u) => u.entry)));
      html = list.length
        ? list.slice(0, state.limit).map((s) => R.separateGroup(s, state.revealed)).join('') + R.more(state.limit, list.length)
        : R.empty(state.query ? 'Nothing here matches your search.' : 'Nothing was held back. Every lookalike was merged.');
    } else if (state.tab === 'asis') {
      const list = state.entries.filter((e) => e.skipReason && (state.cat === 'all' || e.skipReason === state.cat) && matches([e]));
      html = list.length
        ? `<div class="group flat">${list.slice(0, state.limit).map((e) => R.asIsRow(e, state.revealed)).join('')}</div>` + R.more(state.limit, list.length)
        : R.empty(state.query ? 'Nothing here matches your search.' : 'Everything was checked for duplicates.');
    } else {
      const list = state.output.rows.filter((r) => matches([r.entry]));
      html = list.length
        ? `<div class="group flat">${list.slice(0, state.limit).map((r) => R.vaultRow(r, state.revealed)).join('')}</div>` + R.more(state.limit, list.length)
        : R.empty('No entries match your search.');
    }
    view.innerHTML = html;
    for (const el of view.querySelectorAll('[data-hue]')) el.style.setProperty('--hue', el.dataset.hue);
  }

  function render() {
    const loaded = state.files.length > 0;
    $('intake').classList.toggle('compact', loaded);
    for (const id of ['files', 'ledger', 'workspace']) $(id).hidden = !loaded;
    $('startOver').hidden = !loaded;
    if (!loaded) return;
    const c = counts();
    renderFiles();
    renderLedger(c);
    renderTabs(c);
    renderView();
  }

  async function addFiles(fileList) {
    for (const file of fileList) {
      const parsed = parse.parseFile(file.name, await file.text());
      if (parsed.error) toast(`${file.name}: ${parsed.error}.`);
      else state.files.push(parsed);
    }
    state.limit = PAGE;
    recompute();
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function changeList() {
    const cell = (v) => {
      const s = String(v ?? '');
      return '"' + (/^[=+\-@]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
    };
    const line = (action, reason, e, keptName) =>
      [action, reason, R.hostsOf(e).join(' '), e.username, e.name, e.source, e.fileName, keptName].map(cell).join(',');
    const lines = ['Action,Reason,Website,Username,Name,Source,File,Merged into'];
    for (const g of state.analysis.groups) {
      if (state.excluded.has(g.id)) continue;
      lines.push(line('Kept', `${g.removed.length} merged in`, g.kept, ''));
      for (const r of g.removed) lines.push(line('Removed', r.reason, r.entry, g.kept.name));
    }
    for (const s of state.analysis.separate) for (const u of s.units) lines.push(line('Kept separately', s.reason, u.entry, ''));
    return lines.join('\n');
  }

  function openExport() {
    const c = counts();
    $('exportSummary').innerHTML = `
      <li><strong>${R.num(c.in)}</strong> entries in your files</li>
      <li><strong>${R.num(c.removed)}</strong> removed: ${R.num(c.exact)} exact duplicates, ${R.num(c.older)} older passwords</li>
      <li><strong>${R.num(c.out)}</strong> entries in the new vault</li>`;
    $('exportDialog').showModal();
  }

  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
  }

  function onClick(e) {
    const target = e.target.closest('[data-action],[data-tab],[data-kind],[data-cat]');
    if (!target) return;
    if (target.dataset.tab) {
      state.tab = target.dataset.tab;
      state.limit = PAGE;
      return render();
    }
    if (target.dataset.kind) {
      state.kind = target.dataset.kind;
      state.limit = PAGE;
      return render();
    }
    if (target.dataset.cat) {
      state.cat = target.dataset.cat;
      state.limit = PAGE;
      return render();
    }
    const action = target.dataset.action;
    if (action === 'reveal') {
      const uid = target.dataset.uid;
      if (state.revealed.has(uid)) state.revealed.delete(uid);
      else state.revealed.add(uid);
      renderView();
    } else if (action === 'more') {
      state.limit += PAGE;
      renderView();
    } else if (action === 'remove-file') {
      state.files.splice(Number(target.dataset.index), 1);
      recompute();
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.action === 'exclude') {
      if (t.checked) state.excluded.delete(t.dataset.id);
      else state.excluded.add(t.dataset.id);
      state.output = dedupe.buildOutput(state.files, state.entries, state.analysis, state.excluded);
      render();
    } else if (t.id === 'mergeDifferent') {
      state.settings.mergeDifferentPasswords = t.checked;
      recompute();
    } else if (t.id === 'fileInput') {
      addFiles([...t.files]);
      t.value = '';
    }
  }

  function init() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    $('chooseFiles').addEventListener('click', () => $('fileInput').click());
    $('addFile').addEventListener('click', () => $('fileInput').click());
    $('search').addEventListener('input', (e) => {
      state.query = e.target.value;
      state.limit = PAGE;
      renderView();
    });
    $('exportOpen').addEventListener('click', openExport);
    $('exportCancel').addEventListener('click', () => $('exportDialog').close());
    $('exportVault').addEventListener('click', () => {
      const name = `bitwarden-deduped-${timestamp()}.json`;
      download(name, JSON.stringify(state.output.vault, null, 2), 'application/json');
      $('exportDialog').close();
      toast(`Saved ${name} to your Downloads. Next: import it into your test Bitwarden account.`);
    });
    $('exportReport').addEventListener('click', () => download(`dedupe-changes-${timestamp()}.csv`, changeList(), 'text/csv'));
    $('startOver').addEventListener('click', () => {
      Object.assign(state, { files: [], excluded: new Set(), revealed: new Set(), query: '', tab: 'removed', kind: 'all', cat: 'all' });
      $('search').value = '';
      recompute();
    });

    // Stop the browser from opening a dropped file in place of the app.
    for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
    const zone = $('dropzone');
    zone.addEventListener('dragenter', () => zone.classList.add('over'));
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('over');
    });
    zone.addEventListener('drop', (e) => {
      zone.classList.remove('over');
      addFiles([...e.dataTransfer.files]);
    });
    recompute();
  }

  init();
})(globalThis);
