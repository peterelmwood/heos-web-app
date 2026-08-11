/** Connection and account management, surfaced as a settings sheet. */

import { api } from './api.js';
import { h } from './dom.js';
import { showSheet } from './components/sheet.js';
import { attempt, toast } from './components/toast.js';
import { refreshPlayers, refreshSources, refreshStatus, state } from './store.js';

const MODE_LABEL = {
  device: 'Connected to a HEOS device',
  mock: 'Running the built-in simulator',
  disconnected: 'Not connected',
};

export function openSystemSheet() {
  const { status } = state;
  const items = [];

  items.push({
    label: status.account ? `Signed in as ${status.account}` : 'Sign in to HEOS Account',
    icon: 'user',
    onSelect: () => (status.account ? confirmSignOut() : promptSignIn()),
  });

  items.push({
    label: 'Search for HEOS devices',
    icon: 'wifi',
    onSelect: async () => {
      toast('Searching the network…');
      const result = await attempt(() => api.discover());
      if (result) openDevicePicker(result.devices);
    },
  });

  items.push({
    label: 'Connect to a device by address',
    icon: 'link',
    onSelect: () => promptForHost(),
  });

  items.push('divider');
  items.push({
    label: 'Refresh music sources',
    icon: 'refresh',
    onSelect: () => attempt(() => refreshSources(true), { success: 'Sources refreshed' }),
  });

  showSheet({
    title: status.deviceName ?? status.host ?? 'HEOS',
    subtitle: `${MODE_LABEL[status.mode] ?? status.mode}${status.host ? ` · ${status.host}` : ''}`,
    image: undefined,
    note: status.error ?? undefined,
    items,
  });
}

export function openDevicePicker(devices = state.status.discovered ?? []) {
  const items = devices.length
    ? devices.map((device) => ({
        label: device.name ?? device.host,
        icon: 'speaker',
        active: device.host === state.status.host,
        onSelect: () => connect(device.host),
      }))
    : [{ label: 'No devices answered', icon: 'info' }];

  showSheet({
    title: 'HEOS devices',
    subtitle: `${devices.length} found on this network`,
    items,
  });
}

export async function connect(host, port) {
  const result = await attempt(() => api.connect(host, port), { success: `Connected to ${host}` });
  if (result) {
    await refreshStatus();
    await refreshPlayers().catch(() => {});
    await refreshSources().catch(() => {});
  }
  return result;
}

function promptForHost() {
  const input = h('input', {
    type: 'text',
    placeholder: '192.168.1.50',
    style: inputStyle,
  });
  const sheet = showSheet({
    title: 'Connect to a device',
    subtitle: 'Any HEOS speaker on the network will do',
    items: [{ label: 'Connect', icon: 'link', onSelect: () => input.value.trim() && connect(input.value.trim()) }],
  });
  sheet.querySelector('.sheet__grip').after(h('div', { style: { padding: '6px 18px 12px' } }, input));
  input.focus();
}

function promptSignIn() {
  const username = h('input', { type: 'email', placeholder: 'HEOS account email', style: inputStyle });
  const password = h('input', { type: 'password', placeholder: 'Password', style: inputStyle });
  const sheet = showSheet({
    title: 'HEOS Account',
    subtitle: 'Signing in unlocks your music services',
    items: [
      {
        label: 'Sign in',
        icon: 'user',
        onSelect: async () => {
          if (!username.value || !password.value) return;
          const result = await attempt(() => api.signIn(username.value, password.value), { success: 'Signed in' });
          if (result) {
            await refreshStatus();
            await refreshSources(true).catch(() => {});
          }
        },
      },
    ],
  });
  sheet
    .querySelector('.sheet__grip')
    .after(h('div', { style: { padding: '6px 18px 12px', display: 'grid', gap: '8px' } }, username, password));
  username.focus();
}

function confirmSignOut() {
  showSheet({
    title: 'Sign out',
    subtitle: state.status.account ?? '',
    items: [
      {
        label: 'Sign out of HEOS Account',
        icon: 'user',
        danger: true,
        onSelect: async () => {
          await attempt(() => api.signOut(), { success: 'Signed out' });
          await refreshStatus();
          await refreshSources(true).catch(() => {});
        },
      },
    ],
  });
}

const inputStyle = {
  width: '100%',
  padding: '11px 12px',
  borderRadius: '10px',
  background: 'var(--bg-raised)',
  border: '1px solid var(--line)',
  outline: 'none',
};
