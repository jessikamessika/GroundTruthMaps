// Search over the static City of Calgary address index, built by
// api/scraping/build_address_index.py. Runs entirely in the browser.
// Never log the query, an address or a coordinate from here.

const IGNORED_TRAILING = new Set(['CALGARY', 'AB', 'ALBERTA', 'CANADA']);
const ORDINAL = /^(\d+)(?:ST|ND|RD|TH|S|N|R|T)$/;
const MAX_ROWS = 5;

// Added to each code and its official name from the manifest.
export const STREET_TYPE_ALIASES = {
  AL: ['ALY'],
  AV: ['AVE'],
  BV: ['BLVD', 'BOUL'],
  CE: ['CENTER', 'CTR'],
  CI: ['CIR', 'CRCL'],
  CL: ['CLS'],
  CM: ['CMN', 'COMMONS'],
  CO: ['CRT', 'CT'],
  CR: ['CRES', 'CRESC'],
  DR: ['DRV'],
  GA: ['GTE'],
  GD: ['GDN', 'GDNS', 'GARDEN'],
  GR: ['GRN'],
  GV: ['GRV'],
  HE: ['HTH'],
  HI: ['HWY'],
  HL: ['HILLS'],
  HT: ['HTS', 'HEIGHT'],
  IS: ['ISL'],
  LD: ['LNDG'],
  LI: ['LNK'],
  MR: ['MNR'],
  MT: ['MNT'],
  PA: ['PK'],
  PH: ['PTH'],
  PR: ['PDE'],
  PS: ['PSG'],
  PT: ['PNT'],
  PY: ['PKWY', 'PKY'],
  PZ: ['PLZ'],
  ST: ['STR'],
  TC: ['TER', 'TERR', 'TCE'],
  TR: ['TRL'],
  VI: ['VLS', 'VILLA'],
  WK: ['WLK'],
};

const clean = text => text.toUpperCase().replace(/[^A-Z0-9]/g, '');

// The same rule as shard_key() in build_address_index.py.
export function shardKey(streetName) {
  const cleaned = clean(streetName);
  return /^\d/.test(cleaned) ? cleaned : cleaned.slice(0, 3);
}

// { house, alpha, tokens }, or null until there's a house number and the start
// of a street. hasShard keeps a real street name from being read as an ordinal.
export function parseAddressQuery(text, hasShard = () => false) {
  const words = text.toUpperCase().replace(/[.,]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const first = /^(\d+)([A-Z]?)$/.exec(words[0] || '');
  if (!first) return null;
  while (words.length > 2 && IGNORED_TRAILING.has(words[words.length - 1])) words.pop();

  const house = Number(first[1]);
  let alpha = first[2];
  let tokens = words.slice(1);
  if (!alpha && tokens.length > 1 && /^[A-Z]$/.test(tokens[0])) {   // "1407 A 19 St"
    alpha = tokens[0];
    tokens = tokens.slice(1);
  }
  if (!tokens.length) return null;
  const ordinal = ORDINAL.exec(tokens[0]);
  if (ordinal && !hasShard(tokens[0])) tokens = [ordinal[1], ...tokens.slice(1)];
  return { house, alpha, tokens };
}

// Every shard the street could be in: the tokens might include the type and
// quadrant, so try each way of splitting them.
export function candidateShards(tokens) {
  const keys = new Set();
  for (let n = tokens.length; n >= 1; n--) keys.add(shardKey(tokens.slice(0, n).join('')));
  return [...keys];
}

export function streetTypeTerms(streetTypes) {
  const terms = {};
  for (const [code, name] of Object.entries(streetTypes)) {
    terms[code] = [code, name.toUpperCase(), ...(STREET_TYPE_ALIASES[code] || [])];
  }
  return terms;
}

// How well the typed tokens fit a "NAME|TYPE|QUAD" street: 0 for the complete
// name, 1 for a partial one, null for no match.
export function matchStreet(tokens, street, terms) {
  const [name, type, quad] = street.split('|');
  const fullName = clean(name);
  const typeFits = t => (terms[type] || [type]).some(term => term.startsWith(t));
  const tailFits = tail => (
    tail.length === 0 ? true
      : tail.length === 1 ? typeFits(tail[0]) || quad.startsWith(tail[0])
      : tail.length === 2 ? typeFits(tail[0]) && quad.startsWith(tail[1])
      : false
  );
  for (let n = tokens.length; n >= 1; n--) {
    const typed = clean(tokens.slice(0, n).join(''));
    const tail = tokens.slice(n).map(clean);
    if (typed === fullName && tailFits(tail)) return 0;
    if (!tail.length && !/^\d/.test(fullName) && typed && fullName.startsWith(typed)) return 1;
  }
  return null;
}

function friendlyName(name) {
  return name.split(' ').map(word => (
    /\d/.test(word) ? word
      : word.toLowerCase()
        .replace(/(^|-)([a-z])/g, (_, sep, letter) => sep + letter.toUpperCase())
        .replace(/^Mc([a-z])/, (_, letter) => `Mc${letter.toUpperCase()}`)
  )).join(' ');
}

export function addressLabel(number, alpha, street) {
  const [name, type, quad] = street.split('|');
  return `${number}${alpha} ${friendlyName(name)} ${type[0]}${type.slice(1).toLowerCase()} ${quad}`;
}

// One row per point, best matches first, at most MAX_ROWS.
export function findRows(query, shards, terms) {
  const found = [];
  for (const shard of shards) {
    for (const [street, entries] of Object.entries(shard)) {
      const rank = matchStreet(query.tokens, street, terms);
      if (rank === null) continue;
      for (const [number, alpha, points] of entries) {
        if (number === query.house && (!query.alpha || alpha === query.alpha)) {
          found.push({ rank, street, number, alpha, points });
        }
      }
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.street.localeCompare(b.street) || a.alpha.localeCompare(b.alpha));
  return found.flatMap(({ street, number, alpha, points }) => {
    const label = addressLabel(number, alpha, street);
    return points.map((point, i) => ({
      id: `${street}|${number}${alpha}|${i}`,
      label: points.length > 1 ? `${label} · location ${i + 1} of ${points.length}` : label,
      point,
    }));
  }).slice(0, MAX_ROWS);
}

// A session's view of the index in `dir`. search() resolves to
//   { status: 'idle' }             not enough typed yet
//   { status: 'ok', rows }         searched; rows may be empty
//   { status: 'off' }              index unavailable
export function createAddressIndex(dir, fetchJson = defaultFetchJson) {
  let manifest = null;
  const shards = new Map();
  let warned = false;
  const warnOnce = status => {
    if (!warned) console.warn('[address] index unavailable:', status);
    warned = true;
  };

  const ready = () => {
    manifest ??= fetchJson(`${dir}/manifest.json`).then((data) => {
      if (!Array.isArray(data?.shards) || !data.street_types) throw new Error('invalid');
      return { shards: new Set(data.shards), terms: streetTypeTerms(data.street_types) };
    }).catch((e) => {
      warnOnce(e.status ?? (e.message === 'invalid' ? 'invalid' : 'network'));
      return null;
    });
    return manifest;
  };

  const loadShard = (key) => {
    if (!shards.has(key)) {
      shards.set(key, fetchJson(`${dir}/s_${key}.json`).catch((e) => {
        shards.delete(key);   // a later search can try again
        throw e;
      }));
    }
    return shards.get(key);
  };

  const search = async (text) => {
    const index = await ready();
    if (!index) return { status: 'off' };
    const query = parseAddressQuery(text, key => index.shards.has(key));
    if (!query) return { status: 'idle' };
    const typed = clean(query.tokens.join(''));
    if (!/^\d/.test(typed) && typed.length < 3) return { status: 'idle' };

    const keys = candidateShards(query.tokens).filter(key => index.shards.has(key));
    try {
      const loaded = await Promise.all(keys.map(loadShard));
      return { status: 'ok', rows: findRows(query, loaded, index.terms) };
    } catch (e) {
      warnOnce(e.status ?? 'network');
      return { status: 'off' };
    }
  };

  return { ready, search };
}

async function defaultFetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error('http'), { status: r.status });
  try {
    return await r.json();
  } catch (e) {
    throw new Error('invalid');
  }
}
