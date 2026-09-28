import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

describe('loadConfig', () => {
  it('treats empty .env placeholders as unset', () => {
    const config = loadConfig({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GATEWAY_PORT: '' });
    expect(config.google).toBeNull();
    expect(config.port).toBe(7420);
    expect(config.publicUrl).toBe('http://127.0.0.1:7420');
  });

  it('parses Google settings and normalizes the admin allowlist', () => {
    const config = loadConfig({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GATEWAY_ADMIN_EMAILS: ' A@x.com, b@y.org ,',
      GATEWAY_PUBLIC_URL: 'http://localhost:7420/',
    });
    expect(config.google).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      adminEmails: ['a@x.com', 'b@y.org'],
    });
    expect(config.publicUrl).toBe('http://localhost:7420');
  });

  it('refuses half-configured Google credentials', () => {
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: 'id' })).toThrow(/both/);
  });
});
