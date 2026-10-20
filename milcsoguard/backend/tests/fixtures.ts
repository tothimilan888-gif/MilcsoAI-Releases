export const SCHEMA = {
  version: 1,
  actions: ['log', 'warn', 'monitor', 'kick', 'ban'],
  severities: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
  modules: {
    'movement.teleport': {
      label: 'Teleport', category: 'movement', source: 'server',
      defaults: { enabled: true, action: 'kick', severity: 'HIGH' },
      params: {
        maxDistance: { type: 'number', label: 'Max distance', unit: 'm', min: 10, max: 5000, default: 150 },
        ignoreInVehicle: { type: 'boolean', label: 'Ignore in vehicle', default: false },
      },
    },
    'client.heartbeat': {
      label: 'Heartbeat', category: 'client', source: 'client',
      defaults: { enabled: true, action: 'kick', severity: 'MEDIUM' },
      params: {},
    },
    'weapons.blacklist': {
      label: 'Weapon blacklist', category: 'weapons', source: 'server',
      defaults: { enabled: true, action: 'ban', severity: 'CRITICAL' },
      params: { weapons: { type: 'list', label: 'Weapons', maxItems: 3, default: ['WEAPON_RAILGUN'] } },
    },
  },
  risk: { banThreshold: { type: 'integer', label: 'Ban threshold', min: 10, max: 1000, default: 120 } },
};

export function detection(localId: string, extra: Record<string, unknown> = {}) {
  return {
    localId,
    type: 'movement.teleport',
    module: 'movement',
    severity: 'HIGH',
    riskScore: 35,
    source: 'server',
    action: 'warn',
    netId: 12,
    playerName: 'Cheater',
    identifiers: ['license:' + 'a'.repeat(40)],
    evidence: { distance: 812.4 },
    occurredAt: new Date().toISOString(),
    ...extra,
  };
}
