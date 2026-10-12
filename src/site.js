// Maps a login URI to the "site" it belongs to: the registrable domain per the Public Suffix List
// (www.tiktok.com, careers.tiktok.com -> tiktok.com; foo.github.io stays foo.github.io).
(function (root) {
  const VD = (root.VD = root.VD || {});
  let rules, wildcards, exceptions;

  function toAscii(domain) {
    if (/^[\x00-\x7f]*$/.test(domain)) return domain;
    try {
      return new URL('http://' + domain).hostname;
    } catch {
      return domain;
    }
  }

  function loadRules() {
    rules = new Set();
    wildcards = new Set();
    exceptions = new Set();
    for (const raw of VD.pslRules) {
      if (raw.startsWith('!')) exceptions.add(toAscii(raw.slice(1)));
      else if (raw.startsWith('*.')) wildcards.add(toAscii(raw.slice(2)));
      else rules.add(toAscii(raw));
    }
  }

  function registrableDomain(host) {
    if (!rules) loadRules();
    const labels = host.split('.');
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.');
      if (exceptions.has(candidate)) return candidate;
      const parent = labels.slice(i + 1).join('.');
      if (rules.has(candidate) || (parent && wildcards.has(parent))) {
        return i === 0 ? null : labels.slice(i - 1).join('.');
      }
    }
    return labels.length >= 2 ? labels.slice(-2).join('.') : null;
  }

  const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');

  // Returns { key, label, host, local } or null when the URI can't be tied to a site.
  // key = registrable domain; host = full hostname without www.; local = IP/localhost/.local.
  function siteOf(uri) {
    let value = (uri || '').trim();
    if (!value) return null;

    const app = value.match(/^(?:androidapp|iosapp):\/\/([^/?#]+)/i);
    if (app) return appSite(app[1]);
    // Chrome writes Android logins as android://<cert-hash>@<package>/
    const android = value.match(/^android:\/\/[^@]*@([^/?#]+)/i);
    if (android) return appSite(android[1]);

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'https://' + value;
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!/^(https?|ftp):$/.test(url.protocol)) return null;

    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    if (isIp(host) || !host.includes('.') || host.endsWith('.local')) {
      const key = host + (url.port ? ':' + url.port : '');
      return { key, label: key, host: key, local: true };
    }
    const domain = registrableDomain(host) || host;
    return { key: domain, label: domain, host: host.replace(/^www\./, ''), local: false };
  }

  function appSite(id) {
    const key = 'app:' + id.toLowerCase();
    return { key, label: id + ' (app)', host: key, local: false };
  }

  function hasKnownSuffix(host) {
    if (!rules) loadRules();
    const labels = host.split('.');
    for (let i = 1; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.');
      if (rules.has(candidate) || exceptions.has(candidate) || wildcards.has(labels.slice(i + 1).join('.'))) return true;
    }
    return false;
  }

  // For logins saved without a web address: use the entry name when it is a real domain, e.g. "appleid.apple.com".
  function siteOfName(name) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(value) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(value)) return null;
    const site = siteOf(value);
    if (!site || site.local || site.key.startsWith('app:') || !hasKnownSuffix(site.host)) return null;
    return { ...site, fromName: true };
  }

  const displayName = (site) => (site.host.startsWith('app:') ? site.label : site.host);

  VD.site = { siteOf, siteOfName, registrableDomain, displayName };
})(globalThis);
