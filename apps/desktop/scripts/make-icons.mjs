// Makes every app icon from the two logo sources in build/:
// - logo.svg, the colour mark: the app icon on macOS, Windows and Linux;
// - tray.svg, the one-colour mark: the tray and menu bar icons, in resources/tray. The app has no
//   tray yet, and does not ship them (see electron-builder.yml).
// Run it after changing either: `pnpm --filter @dodocode/desktop icons`.
// It runs in Electron, so Chromium draws each SVG at each size instead of scaling one bitmap.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const root = join(import.meta.dirname, "..");
const build = join(root, "build");
const tray = join(root, "resources", "tray");

// The SVG's viewBox and what sits inside it, to place it inside another SVG.
function parseSvg(text) {
  const [, attributes, body] = /<svg\b([^>]*)>([\s\S]*)<\/svg>/.exec(text);
  const viewBox = /viewBox="([^"]+)"/
    .exec(attributes)[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return { viewBox, body };
}

function svg(size, viewSize, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${viewSize} ${viewSize}">${content}</svg>`;
}

// Draws `mark` `height` units tall with its top-left corner at (x, y).
function place(mark, x, y, height) {
  const [, , w, h] = mark.viewBox;
  return `<svg x="${x}" y="${y}" width="${(height * w) / h}" height="${height}" viewBox="${mark.viewBox.join(" ")}" overflow="visible">${mark.body}</svg>`;
}

// The mark alone, filling a square. Its straight left, top and bottom edges land on whole pixels,
// so they stay sharp at 16 px.
function bareIcon(mark, size, margin) {
  const [, , w, h] = mark.viewBox;
  const pad = Math.max(1, Math.round(size * margin));
  const height = size - 2 * pad;
  const x = Math.round((size - (height * w) / h) / 2);
  return svg(size, size, place(mark, x, pad, height));
}

// The macOS icon: the mark on a dark rounded plate, on Apple's 1024 grid (an 824 plate, inset 100,
// with room for its shadow).
function macIcon(mark, size) {
  const [, , w, h] = mark.viewBox;
  const height = 460;
  const width = (height * w) / h;
  return svg(
    size,
    1024,
    `<defs>
      <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2a2622"/>
        <stop offset="1" stop-color="#141210"/>
      </linearGradient>
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
        <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.3"/>
      </filter>
    </defs>
    <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#plate)" filter="url(#shadow)"/>
    <rect x="101" y="101" width="822" height="822" rx="184" fill="none" stroke="#fff" stroke-opacity="0.08" stroke-width="2"/>
    ${place(mark, 512 - width / 2, 512 - height / 2, height)}`,
  );
}

// Runs in the page: draws the SVG at `size` and returns it as a PNG and as raw RGBA, both base64.
async function draw(source, size) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return { png: canvas.toDataURL("image/png").split(",")[1], rgba: btoa(binary) };
}

// A 32-bit bitmap entry for an .ico: bottom-up BGRA rows, then an empty AND mask (the alpha
// channel does the masking). Windows reads these at every size, even where it skips PNG entries.
function icoBitmap(size, rgba) {
  const header = Buffer.alloc(40);
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(pixels.length + mask.length, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

// An .ico holding each image: bitmaps below 256 px, PNG at 256 px.
function ico(images) {
  const entries = images.map(({ size, png, rgba }) => (size >= 256 ? png : icoBitmap(size, rgba)));
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size }, i) => {
    const at = 6 + 16 * i;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entries[i].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entries[i].length;
  });
  return Buffer.concat([directory, ...entries]);
}

// An .icns of PNG entries, each [type, png].
function icns(entries) {
  const chunks = entries.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// Each .icns type and the pixel size it holds; the @2x types reuse the larger image.
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];
const WINDOWS_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512];
// The tray icon at 16 px and the screen scales Electron picks a sibling file for.
const TRAY_SCALES = [
  ["", 16],
  ["@1.25x", 20],
  ["@1.5x", 24],
  ["@2x", 32],
];
// The macOS menu bar only asks for 1x and 2x.
const TEMPLATE_SCALES = TRAY_SCALES.filter(([scale]) => scale === "" || scale === "@2x");

async function makeIcons(window) {
  const render = async (source, size) => {
    const result = await window.webContents.executeJavaScript(
      `(${draw.toString()})(${JSON.stringify(source)}, ${size})`,
    );
    return {
      size,
      png: Buffer.from(result.png, "base64"),
      rgba: Buffer.from(result.rgba, "base64"),
    };
  };

  const logo = parseSvg(await readFile(join(build, "logo.svg"), "utf8"));
  const mono = await readFile(join(build, "tray.svg"), "utf8");
  // A macOS template image is black; the menu bar recolours it for light and dark.
  const template = parseSvg(mono.replaceAll(/fill="white"/g, 'fill="black"'));
  const light = parseSvg(mono);

  const mac = new Map();
  for (const size of new Set(ICNS_TYPES.map(([, pixels]) => pixels))) {
    mac.set(size, (await render(macIcon(logo, size), size)).png);
  }
  await writeFile(
    join(build, "icon.icns"),
    icns(ICNS_TYPES.map(([type, size]) => [type, mac.get(size)])),
  );

  const windows = [];
  for (const size of WINDOWS_SIZES) windows.push(await render(bareIcon(logo, size, 0.06), size));
  await writeFile(join(build, "icon.ico"), ico(windows));

  await mkdir(join(build, "icons"), { recursive: true });
  for (const size of LINUX_SIZES) {
    const { png } = await render(bareIcon(logo, size, 0.06), size);
    await writeFile(join(build, "icons", `${size}x${size}.png`), png);
  }

  await mkdir(tray, { recursive: true });
  for (const [suffix, size] of TRAY_SCALES) {
    const { png } = await render(bareIcon(light, size, 1 / 16), size);
    await writeFile(join(tray, `tray${suffix}.png`), png);
  }
  for (const [suffix, size] of TEMPLATE_SCALES) {
    const { png } = await render(bareIcon(template, size, 1 / 16), size);
    await writeFile(join(tray, `trayTemplate${suffix}.png`), png);
  }
}

app.dock?.hide();
void app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ show: false });
    await window.loadURL("about:blank");
    await makeIcons(window);
    console.log("Icons written to build/ and resources/tray/.");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
