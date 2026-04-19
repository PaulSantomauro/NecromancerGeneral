// Identity is tab-scoped via sessionStorage so two tabs on the same machine
// are independent generals. A name → uuid map in localStorage lets the same
// name consistently reclaim the same general across tabs, reloads, and revisits.

const SESSION_ID_KEY   = 'ng_pid';
const SESSION_NAME_KEY = 'ng_name';
const LS_NAME_MAP_KEY  = 'ng_name_to_id';
const LS_LAST_NAME_KEY = 'ng_last_name';

function readNameMap() {
  try {
    return JSON.parse(localStorage.getItem(LS_NAME_MAP_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeNameMap(map) {
  try {
    localStorage.setItem(LS_NAME_MAP_KEY, JSON.stringify(map));
  } catch {}
}

export function getIdentity() {
  const id = sessionStorage.getItem(SESSION_ID_KEY);
  const name = sessionStorage.getItem(SESSION_NAME_KEY)
            || localStorage.getItem(LS_LAST_NAME_KEY)
            || '';
  return { id, name };
}

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts (HTTP over LAN)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function claimIdentity(rawName) {
  const name = rawName.trim().slice(0, 20);
  if (!name) return null;

  const map = readNameMap();
  let id = map[name];
  if (!id) {
    id = generateUUID();
    map[name] = id;
    writeNameMap(map);
  }

  sessionStorage.setItem(SESSION_ID_KEY, id);
  sessionStorage.setItem(SESSION_NAME_KEY, name);
  localStorage.setItem(LS_LAST_NAME_KEY, name);

  return { id, name };
}
