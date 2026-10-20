import { describe, expect, it } from 'vitest';
import { diffOverrides } from '../pages/Config';
import { qs } from './api';
import type { ConfigSchema } from './types';

const schema: ConfigSchema = {
  version: 1, actions: ['log', 'warn', 'kick', 'ban'], severities: ['LOW', 'HIGH'],
  modules: {
    'movement.teleport': { label: 'T', category: 'movement', description: '', limitations: '', source: 'server', defaults: { enabled: true, action: 'warn', severity: 'HIGH' }, params: { max: { type: 'number', label: 'm', min: 1, max: 9, default: 5 }, list: { type: 'list', label: 'l', maxItems: 5, default: ['A'] } } },
  },
  risk: { banThreshold: { type: 'integer', label: 'b', min: 1, max: 999, default: 140 } },
};

describe('diffOverrides', () => {
  it('sends only values that differ from the defaults', () => {
    const o = diffOverrides(schema, { 'movement.teleport': { enabled: true, action: 'warn', severity: 'HIGH', params: { max: 5, list: ['A'] } } }, { banThreshold: 140 });
    expect(o).toEqual({ modules: {}, risk: {} });
  });
  it('includes changed actions, params and risk values', () => {
    const o = diffOverrides(schema, { 'movement.teleport': { enabled: false, action: 'kick', severity: 'HIGH', params: { max: 7, list: ['A', 'B'] } } }, { banThreshold: 200 });
    expect(o).toEqual({ modules: { 'movement.teleport': { enabled: false, action: 'kick', params: { max: 7, list: ['A', 'B'] } } }, risk: { banThreshold: 200 } });
  });
});

describe('qs', () => {
  it('skips empty values and encodes the rest', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: 'x y' })).toBe('?a=1&d=x+y');
    expect(qs({})).toBe('');
  });
});
