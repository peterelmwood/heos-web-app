/** Runtime configuration, all overridable through the environment. */

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const config = {
  /** HTTP port for the web UI and REST API. */
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Skip discovery and connect straight to this speaker. */
  heosHost: process.env.HEOS_HOST || null,
  heosPort: Number(process.env.HEOS_PORT ?? 1255),
  /** Force the built-in simulator instead of looking for hardware. */
  mock: bool(process.env.HEOS_MOCK),
  /** Fall back to the simulator when no speaker answers discovery. */
  mockFallback: bool(process.env.HEOS_MOCK_FALLBACK, true),
  discoveryTimeout: Number(process.env.HEOS_DISCOVERY_TIMEOUT ?? 5000),
  /** Optional HEOS account credentials, used to unlock streaming services. */
  account: {
    username: process.env.HEOS_USERNAME || null,
    password: process.env.HEOS_PASSWORD || null,
  },
};
