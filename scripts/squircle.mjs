// Apply Apple's macOS Big Sur+ icon mask (squircle with 100px gutter inside a
// 1024px canvas) to a square source PNG. Outputs a transparent PNG suitable
// for `tauri icon`.
//
// Usage: bun scripts/squircle.mjs <input.png> <output.png>

import sharp from "sharp";

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error("Usage: bun scripts/squircle.mjs <input.png> <output.png>");
  process.exit(1);
}

const SIZE = 1024;
const INNER = 824;
const PAD = (SIZE - INNER) / 2; // 100
// Continuous-corner ("squircle") radius. The bezier handles below put the
// curve start at PAD + R from each edge, with control points pulled toward
// the corner for the smooth Apple-style transition.
const R = 187.7;
const C = 62; // control-point offset from corner

const mask = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    <path d="M ${PAD} ${PAD + R}
             C ${PAD} ${PAD + C} ${PAD + C} ${PAD} ${PAD + R} ${PAD}
             L ${PAD + INNER - R} ${PAD}
             C ${PAD + INNER - C} ${PAD} ${PAD + INNER} ${PAD + C} ${PAD + INNER} ${PAD + R}
             L ${PAD + INNER} ${PAD + INNER - R}
             C ${PAD + INNER} ${PAD + INNER - C} ${PAD + INNER - C} ${PAD + INNER} ${PAD + INNER - R} ${PAD + INNER}
             L ${PAD + R} ${PAD + INNER}
             C ${PAD + C} ${PAD + INNER} ${PAD} ${PAD + INNER - C} ${PAD} ${PAD + INNER - R}
             Z" fill="white"/>
  </svg>`,
);

const innerImage = await sharp(input)
  .resize(INNER, INNER, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .extend({
    top: PAD,
    bottom: PAD,
    left: PAD,
    right: PAD,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

await sharp({
  create: {
    width: SIZE,
    height: SIZE,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    { input: innerImage, blend: "over" },
    { input: mask, blend: "dest-in" },
  ])
  .png()
  .toFile(output);

console.log(`Wrote ${output}`);
