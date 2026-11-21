const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Resvg } = require(path.join(__dirname, '../apps/api/node_modules/@resvg/resvg-js'));

const OUTPUT_DIR = path.join(__dirname, 'anim_frames');
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const TOTAL_FRAMES = 150; // 5 seconds at 30 fps
const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1080;

// Deterministic particles
const particles = [];
for (let i = 0; i < 35; i++) {
  particles.push({
    x: (i * 31.7) % WIDTH,
    startY: (i * 29.3) % HEIGHT,
    speed: 0.8 + ((i * 17) % 15) / 10,
    size: 2 + (i % 4),
    baseOpacity: 0.2 + ((i * 7) % 8) / 10,
    phase: (i * 0.4)
  });
}

// Orbiting satellites
const satellites = [
  { radiusX: 260, radiusY: 90, tilt: -25, speed: 1, color: '#38bdf8', size: 7 },
  { radiusX: 300, radiusY: 105, tilt: 35, speed: -0.8, color: '#818cf8', size: 6 },
  { radiusX: 240, radiusY: 80, tilt: 70, speed: 1.2, color: '#22d3ee', size: 5 }
];

console.log(`Generating ${TOTAL_FRAMES} frames at ${WIDTH}x${HEIGHT}...`);

for (let f = 0; f < TOTAL_FRAMES; f++) {
  const t = f / TOTAL_FRAMES; // 0.0 to 1.0 (loop)
  const angle = t * 2 * Math.PI;

  // Floating bob for emblem
  const bobY = Math.sin(angle) * 16;
  const shadowScale = 1.0 - (bobY / 70);
  const shadowOpacity = 0.45 - (bobY / 120);

  // Pulse rings
  const pulse1 = (t * 2) % 1.0;
  const pulse2 = ((t * 2) + 0.33) % 1.0;
  const pulse3 = ((t * 2) + 0.66) % 1.0;

  // Specular sheen sweep position (across 1080px)
  const sheenPos = (t * 2000) - 400;

  // Render particles
  let particleSvg = '';
  particles.forEach(p => {
    const curY = (p.startY - (f * p.speed * 2) + HEIGHT * 2) % HEIGHT;
    const flicker = Math.sin(angle * 2 + p.phase) * 0.3 + 0.7;
    const op = Math.max(0.1, Math.min(1.0, p.baseOpacity * flicker));
    particleSvg += `<circle cx="${p.x.toFixed(1)}" cy="${curY.toFixed(1)}" r="${p.size}" fill="#38bdf8" opacity="${op.toFixed(2)}" filter="url(#glowSubtle)"/>`;
  });

  // Calculate satellites in 3D orbit
  let behindSatellites = '';
  let inFrontSatellites = '';

  satellites.forEach(s => {
    const curAngle = angle * s.speed + (s.tilt * Math.PI / 180);
    const rawX = Math.cos(curAngle) * s.radiusX;
    const rawY = Math.sin(curAngle) * s.radiusY;

    // Apply tilt rotation
    const rad = s.tilt * Math.PI / 180;
    const rotX = rawX * Math.cos(rad) - rawY * Math.sin(rad);
    const rotY = rawX * Math.sin(rad) + rawY * Math.cos(rad);

    const satX = (WIDTH / 2) + rotX;
    const satY = (HEIGHT / 2 - 80) + rotY + bobY * 0.5;
    const isFront = Math.sin(curAngle) > 0;

    const satEl = `
      <g>
        <circle cx="${satX.toFixed(1)}" cy="${satY.toFixed(1)}" r="${s.size * 2}" fill="${s.color}" opacity="0.3" filter="url(#glowStrong)"/>
        <circle cx="${satX.toFixed(1)}" cy="${satY.toFixed(1)}" r="${s.size}" fill="#ffffff"/>
      </g>
    `;

    if (isFront) {
      inFrontSatellites += satEl;
    } else {
      behindSatellites += satEl;
    }
  });

  // Generate SVG Frame
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <!-- Deep Space Background Gradient -->
    <radialGradient id="bgGrad" cx="50%" cy="40%" r="70%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="50%" stop-color="#050814" />
      <stop offset="100%" stop-color="#020408" />
    </radialGradient>

    <!-- Core Ambient Blooms -->
    <radialGradient id="coreBloom" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#2563eb" stop-opacity="${(0.55 + Math.sin(angle)*0.1).toFixed(2)}" />
      <stop offset="45%" stop-color="#06b6d4" stop-opacity="${(0.25 + Math.sin(angle)*0.08).toFixed(2)}" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </radialGradient>

    <radialGradient id="cyanFlare" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.8" />
      <stop offset="60%" stop-color="#2563eb" stop-opacity="0.2" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </radialGradient>

    <!-- Logo Emblem Gradient -->
    <linearGradient id="logoBg" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1d4ed8" />
      <stop offset="50%" stop-color="#4f46e5" />
      <stop offset="100%" stop-color="#06b6d4" />
    </linearGradient>

    <!-- Border highlight -->
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#bae6fd" stop-opacity="0.9" />
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.5" />
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0.8" />
    </linearGradient>

    <!-- Specular Light Sheen -->
    <linearGradient id="sheen" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="45%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.65" />
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>

    <!-- Text Shimmer -->
    <linearGradient id="textShimmer" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="${Math.max(0, (t * 1.5 - 0.2)).toFixed(2)}" stop-color="#ffffff" />
      <stop offset="${(t * 1.5).toFixed(2)}" stop-color="#38bdf8" />
      <stop offset="${Math.min(1, (t * 1.5 + 0.2)).toFixed(2)}" stop-color="#ffffff" />
    </linearGradient>

    <!-- Glow Filters -->
    <filter id="glowStrong" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="18" />
    </filter>
    <filter id="glowSubtle" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
    </filter>

    <!-- Emblem Clip for Sheen -->
    <clipPath id="emblemClip">
      <rect x="0" y="0" width="320" height="320" rx="78" ry="78" />
    </clipPath>
  </defs>

  <!-- 1. Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGrad)" />

  <!-- 2. Cyber Perspective Grid at Bottom -->
  <g opacity="0.22">
    <!-- Horizon Line -->
    <line x1="0" y1="880" x2="${WIDTH}" y2="880" stroke="#38bdf8" stroke-width="1.5" />
    <line x1="0" y1="920" x2="${WIDTH}" y2="920" stroke="#38bdf8" stroke-width="1" />
    <line x1="0" y1="970" x2="${WIDTH}" y2="970" stroke="#38bdf8" stroke-width="1" />
    <line x1="0" y1="1030" x2="${WIDTH}" y2="1030" stroke="#38bdf8" stroke-width="1" />

    <!-- Vanishing Lines to Center Horizon (540, 840) -->
    <line x1="540" y1="840" x2="-200" y2="1080" stroke="#38bdf8" stroke-width="1" />
    <line x1="540" y1="840" x2="100" y2="1080" stroke="#38bdf8" stroke-width="1" />
    <line x1="540" y1="840" x2="300" y2="1080" stroke="#38bdf8" stroke-width="1" />
    <line x1="540" y1="840" x2="450" y2="1080" stroke="#38bdf8" stroke-width="1" />
    <line x1="540" y1="840" x2="630" y2="1080" stroke="#38bdf8" stroke-width="1" />
    <line x1="540" y1="840" x2="780" y2="1080" stroke="#38bdf8" stroke-width="1" />
    <line x1="540" y1="840" x2="980" y2="1080" stroke="#38bdf8" stroke-width="1" />
    <line x1="540" y1="840" x2="1280" y2="1080" stroke="#38bdf8" stroke-width="1" />
  </g>

  <!-- 3. Floating Embers / Starfield -->
  ${particleSvg}

  <!-- 4. Massive Ambient Radial Bloom behind Emblem -->
  <circle cx="540" cy="${(440 + bobY * 0.5).toFixed(1)}" r="360" fill="url(#coreBloom)" />
  <circle cx="540" cy="${(440 + bobY * 0.5).toFixed(1)}" r="180" fill="url(#cyanFlare)" />

  <!-- 5. Expanding Energy Pulse Shockwaves -->
  <circle cx="540" cy="${(440 + bobY * 0.5).toFixed(1)}" r="${(160 + pulse1 * 280).toFixed(1)}" fill="none" stroke="#38bdf8" stroke-width="3" opacity="${((1 - pulse1) * 0.6).toFixed(2)}" />
  <circle cx="540" cy="${(440 + bobY * 0.5).toFixed(1)}" r="${(160 + pulse2 * 280).toFixed(1)}" fill="none" stroke="#818cf8" stroke-width="2" opacity="${((1 - pulse2) * 0.5).toFixed(2)}" />
  <circle cx="540" cy="${(440 + bobY * 0.5).toFixed(1)}" r="${(160 + pulse3 * 280).toFixed(1)}" fill="none" stroke="#22d3ee" stroke-width="1.5" stroke-dasharray="10 15" opacity="${((1 - pulse3) * 0.5).toFixed(2)}" />

  <!-- 6. Satellites Behind Logo -->
  ${behindSatellites}

  <!-- 7. Dynamic Ground Shadow below floating emblem -->
  <ellipse cx="540" cy="650" rx="${(140 * shadowScale).toFixed(1)}" ry="${(26 * shadowScale).toFixed(1)}" fill="#000000" opacity="${shadowOpacity.toFixed(2)}" filter="url(#glowSubtle)" />

  <!-- 8. Floating BloxCloud Emblem Group -->
  <g transform="translate(380, ${(280 + bobY).toFixed(1)})">
    <!-- Glow Backdrop around emblem -->
    <rect x="-10" y="-10" width="340" height="340" rx="88" ry="88" fill="#2563eb" opacity="0.3" filter="url(#glowStrong)" />

    <!-- Main Clipped Emblem -->
    <g clip-path="url(#emblemClip)">
      <!-- Gradient Fill -->
      <rect x="0" y="0" width="320" height="320" fill="url(#logoBg)" />

      <!-- High-Tech Inner Glow Grid lines on logo face -->
      <g opacity="0.15">
        <line x1="80" y1="0" x2="80" y2="320" stroke="#ffffff" stroke-width="2" />
        <line x1="160" y1="0" x2="160" y2="320" stroke="#ffffff" stroke-width="2" />
        <line x1="240" y1="0" x2="240" y2="320" stroke="#ffffff" stroke-width="2" />
        <line x1="0" y1="80" x2="320" y2="80" stroke="#ffffff" stroke-width="2" />
        <line x1="0" y1="160" x2="320" y2="160" stroke="#ffffff" stroke-width="2" />
        <line x1="0" y1="240" x2="320" y2="240" stroke="#ffffff" stroke-width="2" />
      </g>

      <!-- Specular Laser Light Sweep passing across emblem -->
      <rect x="${(sheenPos - 380).toFixed(1)}" y="-100" width="220" height="520" fill="url(#sheen)" transform="rotate(30, 160, 160)" />
    </g>

    <!-- Glassmorphic Border -->
    <rect x="0" y="0" width="320" height="320" rx="78" ry="78" fill="none" stroke="url(#borderGrad)" stroke-width="7" />

    <!-- Official BloxCloud 3D Isometric Cube -->
    <!-- Scaled from the 512px SVG path: scale ~0.33, centered at 160, 160 -->
    <g transform="translate(80, 80) scale(0.3125)">
      <path fill="#ffffff" filter="url(#glowSubtle)" opacity="0.3" d="M239.1 6.3l-208 78c-18.7 7-31.1 25-31.1 45v225.1c0 18.2 10.3 34.8 26.5 42.9l208 104c13.5 6.8 29.4 6.8 42.9 0l208-104c16.3-8.1 26.5-24.8 26.5-42.9V129.3c0-20-12.4-37.9-31.1-44.9l-208-78C262 2.2 250 2.2 239.1 6.3zM256 68.4l192 72v1.1l-192 78-192-78v-1.1l192-72zm32 356V275.5l160-65.3v174.3l-160 80z"/>
      <path fill="#ffffff" d="M239.1 6.3l-208 78c-18.7 7-31.1 25-31.1 45v225.1c0 18.2 10.3 34.8 26.5 42.9l208 104c13.5 6.8 29.4 6.8 42.9 0l208-104c16.3-8.1 26.5-24.8 26.5-42.9V129.3c0-20-12.4-37.9-31.1-44.9l-208-78C262 2.2 250 2.2 239.1 6.3zM256 68.4l192 72v1.1l-192 78-192-78v-1.1l192-72zm32 356V275.5l160-65.3v174.3l-160 80z"/>
    </g>
  </g>

  <!-- 9. Satellites In Front of Logo -->
  ${inFrontSatellites}

  <!-- 10. Brand Typography Group -->
  <g transform="translate(540, 755)">
    <!-- Main Title: BLOXCLOUD -->
    <text x="0" y="0" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="900" font-size="70" letter-spacing="14" fill="#0284c7" opacity="0.6" filter="url(#glowStrong)">BLOXCLOUD</text>
    <text x="0" y="0" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="900" font-size="70" letter-spacing="14" fill="url(#textShimmer)">BLOXCLOUD</text>

    <!-- Subtitle Pill: Enterprise Backend -->
    <g transform="translate(0, 48)">
      <rect x="-260" y="-22" width="520" height="44" rx="22" ry="22" fill="#0f172a" stroke="#1e293b" stroke-width="2" />
      <rect x="-260" y="-22" width="520" height="44" rx="22" ry="22" fill="none" stroke="#38bdf8" stroke-width="1.5" opacity="${(0.4 + Math.sin(angle)*0.2).toFixed(2)}" />
      <text x="0" y="7" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="19" letter-spacing="4" fill="#94a3b8">
        CLOUD BACKEND <tspan fill="#38bdf8">•</tspan> LIVEOPS
      </text>
    </g>

    <!-- Dual Platform Support Tag -->
    <g transform="translate(0, 116)">
      <text x="0" y="0" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="22" letter-spacing="5" fill="#f8fafc">
        ROBLOX STUDIOS <tspan fill="#06b6d4">&amp;</tspan> MINECRAFT NETWORKS
      </text>
    </g>

    <!-- Website URL with Cyan Pulse -->
    <g transform="translate(0, 175)">
      <text x="0" y="0" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="800" font-size="26" letter-spacing="3" fill="#38bdf8" filter="url(#glowSubtle)" opacity="0.8">bloxcloud.world</text>
      <text x="0" y="0" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="800" font-size="26" letter-spacing="3" fill="#ffffff">bloxcloud.world</text>
    </g>
  </g>
</svg>
`;

  const resvg = new Resvg(svg, { font: { loadSystemFonts: true } });
  const pngData = resvg.render().asPng();
  const framePath = path.join(OUTPUT_DIR, `frame_${String(f).padStart(4, '0')}.png`);
  fs.writeFileSync(framePath, pngData);

  if (f % 30 === 0 || f === TOTAL_FRAMES - 1) {
    console.log(`Rendered frame ${f + 1}/${TOTAL_FRAMES}`);
  }
}

console.log('All frames generated successfully! Now assembling MP4 and GIF with ffmpeg...');

const MP4_OUT = path.join(__dirname, '../apps/dashboard/public/bloxcloud-promo.mp4');
const GIF_OUT = path.join(__dirname, '../apps/dashboard/public/bloxcloud-promo.gif');

// Compile MP4 (H.264 high quality, yuv420p for max compatibility across Twitter/Reddit/Discord)
console.log('Compiling MP4...');
const mp4Res = spawnSync('ffmpeg', [
  '-y',
  '-framerate', String(FPS),
  '-i', path.join(OUTPUT_DIR, 'frame_%04d.png'),
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-crf', '18',
  '-preset', 'slow',
  MP4_OUT
], { stdio: 'inherit' });

// Compile high-quality palette-optimized GIF
console.log('Compiling high-quality GIF...');
const palettePath = path.join(OUTPUT_DIR, 'palette.png');
spawnSync('ffmpeg', [
  '-y',
  '-i', MP4_OUT,
  '-vf', 'fps=20,scale=540:-1:flags=lanczos,palettegen',
  palettePath
], { stdio: 'inherit' });

spawnSync('ffmpeg', [
  '-y',
  '-i', MP4_OUT,
  '-i', palettePath,
  '-lavfi', 'fps=20,scale=540:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3',
  GIF_OUT
], { stdio: 'inherit' });

console.log('Finished rendering marketing animation!');
console.log('MP4:', MP4_OUT);
console.log('GIF:', GIF_OUT);
