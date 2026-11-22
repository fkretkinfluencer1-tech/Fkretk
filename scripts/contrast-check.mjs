import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const css = await readFile(resolve(scriptDir, '../assets/fikratak-design.css'), 'utf8');

function lastTokenBlock(selector) {
  const expression = /([^{}]+)\{([^{}]*)\}/g;
  const matches = [...css.matchAll(expression)].filter((match) =>
    match[1].split(',').some((part) => part.trim() === selector));
  if (!matches.length) throw new Error(`Missing token block: ${selector}`);
  return matches.at(-1)[2];
}

function readToken(block, name) {
  const match = block.match(new RegExp(`--fk-${name}\\s*:\\s*(#[\\da-fA-F]{6})\\s*;`));
  if (!match) throw new Error(`Missing hex color token --fk-${name}.`);
  return match[1];
}

function luminance(hex) {
  const { red, green, blue } = parseColor(hex);
  const channels = [red, green, blue];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function parseColor(value) {
  const hex = value.match(/^#([\da-f]{6})$/i);
  if (hex) {
    const [red, green, blue] = hex[1].match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255);
    return { red, green, blue, alpha: 1 };
  }
  const rgba = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgba) throw new Error(`Unsupported color value: ${value}`);
  return {
    red: Number(rgba[1]) / 255,
    green: Number(rgba[2]) / 255,
    blue: Number(rgba[3]) / 255,
    alpha: rgba[4] === undefined ? 1 : Number(rgba[4])
  };
}

function composite(foreground, background) {
  const color = parseColor(foreground);
  const base = parseColor(background);
  return [color.red, color.green, color.blue].map((channel, index) =>
    channel * color.alpha + [base.red, base.green, base.blue][index] * (1 - color.alpha));
}

function readCssValue(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|[;{\\s])${escapedName}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS token ${name}.`);
  return match[1].trim();
}

function contrast(foreground, background) {
  const [red, green, blue] = composite(foreground, background);
  const foregroundLuminance = (() => {
    const channels = [red, green, blue];
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  })();
  const values = [foregroundLuminance, luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const themes = [
  { name: 'light', selector: ':root' },
  { name: 'dark', selector: ':root[data-theme="dark"]' }
];
let failures = 0;
for (const theme of themes) {
  const block = lastTokenBlock(theme.selector);
  const background = readToken(block, 'paper');
  const surface = readToken(block, 'surface');
  const text = readToken(block, 'ink');
  const muted = readToken(block, 'muted');
  for (const [label, foreground, backdrop] of [
    ['text / background', text, background],
    ['muted / background', muted, background],
    ['text / surface', text, surface],
    ['muted / surface', muted, surface]
  ]) {
    const ratio = contrast(foreground, backdrop);
    console.log(`${theme.name} ${label}: ${ratio.toFixed(2)}:1`);
    if (ratio < 4.5) failures += 1;
  }
}

const brandTokens = {
  foreground: readCssValue('--on-brand'),
  muted: readCssValue('--on-brand-muted'),
  subtle: readCssValue('--on-brand-subtle'),
  glass: readCssValue('--glass-bg')
};
const fixedSurfaces = [
  { name: 'Hero', background: '#175991', tokens: ['foreground', 'muted'] },
  { name: 'Brand panel', background: '#175991', tokens: ['foreground', 'muted'] },
  { name: 'Sidebar', background: '#081B28', tokens: ['foreground', 'muted', 'subtle'] }
];
for (const theme of themes) {
  for (const surface of fixedSurfaces) {
    for (const tokenName of surface.tokens) {
      const ratio = contrast(brandTokens[tokenName], surface.background);
      console.log(`${theme.name} ${surface.name} / ${tokenName}: ${ratio.toFixed(2)}:1`);
      if (ratio < 4.5) failures += 1;
    }
    if (surface.name === 'Hero') {
      const glassSurface = composite(brandTokens.glass, surface.background)
        .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('');
      const ratio = contrast(brandTokens.foreground, `#${glassSurface}`);
      console.log(`${theme.name} Hero glass / foreground: ${ratio.toFixed(2)}:1`);
      if (ratio < 4.5) failures += 1;
    }
  }
}

if (failures) {
  console.error(`${failures} text/background pair(s) failed WCAG AA (4.5:1).`);
  process.exitCode = 1;
} else {
  console.log('All checked text/background pairs meet WCAG AA (4.5:1).');
}
