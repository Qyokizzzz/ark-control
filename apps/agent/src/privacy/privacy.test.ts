import { describe, expect, it } from 'vitest';
import { redactText } from './index';
describe('game log credential redaction', () => {
  it('preserves numeric game facts and token counters while masking labelled short passwords', () => {
    const text = 'Tribe 123 killed 1 dino; Token=100';
    expect(redactText(text, ['1', '123'])).toBe(text);
    expect(redactText('ServerPassword=123', ['123'])).toBe('ServerPassword=[已隐藏]');
  });
  it('redacts launch URL credentials with or without known secret values', () => {
    const text =
      'Commandline: TheIsland?RCONEnabled=True?RCONPort=27021?ServerAdminPassword=admin-secret?ServerPassword=join-secret -server';
    const value = redactText(text);
    expect(value).not.toMatch(/admin-secret|join-secret/);
    expect(value).toContain('RCONPort=27021');
    expect(value).toContain('ServerAdminPassword=[已隐藏]');
  });
  it('redacts naked secrets and quoted values before output is truncated', () => {
    const source = 'x'.repeat(4000) + ' private-admin-password ServerPassword="with spaces"';
    const value = redactText(source, ['private-admin-password']).slice(-3000);
    expect(value).not.toMatch(/private-admin-password|with spaces/);
  });
  it('preserves full non-sensitive tribe log text', () => {
    const text = '部落事件'.repeat(6000);
    expect(redactText(text, ['secret'])).toBe(text);
  });
});
