import { describe, expect, it } from 'vitest';
import { cycleThemeColor } from './theme.js';

describe('theme color selection', () => {
  it('skips an excluded color in either direction', () => {
    expect(cycleThemeColor('green', 1, 'cyan')).toBe('gold');
    expect(cycleThemeColor('gold', -1, 'cyan')).toBe('green');
  });

  it('wraps while still skipping the excluded color', () => {
    expect(cycleThemeColor('rose', 1, 'green')).toBe('cyan');
    expect(cycleThemeColor('green', -1, 'rose')).toBe('violet');
  });
});
