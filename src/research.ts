export type ResearchCategory = 'S' | 'F' | 'D' | 'W';

/** The only information an opponent gets from an upgrade lab. */
export function researchCategory(item: string): ResearchCategory {
  if (item === 'advancedFighters' || item === 'bomberyard' || item === 'swarmyard') return 'F';
  if (item.includes('turret') || item === 'advancedRegenTurrets' || item === 'synonymousminelayer') return 'D';
  if (item.startsWith('weapon')) return 'W';
  return 'S';
}

/** Compact owner-only icon identifying the exact upgrade housed in a lab. */
export function researchIcon(item: string): string {
  const icons: Record<string, string> = {
    shipHp1: 'H1', shipHp2: 'H2', shipHp3: 'H3', shipHp4: 'H4',
    shipSpeedEnergy1: 'E1', shipSpeedEnergy2: 'E2', shipSpeedEnergy3: 'E3', shipSpeedEnergy4: 'E4',
    shipShield1: 'Q1', shipShield2: 'Q2', shipDash: '>>',
    weaponCannon: 'CN', weaponGatling: 'GT', weaponLaser: 'LZ', weaponGuidedMissile: 'GM',
    advancedFighters: 'AF', bomberyard: 'BM', swarmyard: 'SW',
    missileturret: 'MS', exciterturret: 'PR', massdriverturret: 'SG', regenturret: 'RP',
    advancedRegenTurrets: 'R+', synonymousminelayer: 'MN',
    synonymousPierce: 'PI', synonymousSpeed: 'SP', synonymousVitality: 'VT',
    synonymousFireSpeed1: 'P1', synonymousFireSpeed2: 'P2', synonymousFireSpeed3: 'P3', synonymousFireSpeed4: 'P4',
  };
  return icons[item] ?? item.slice(0, 2).toUpperCase();
}
