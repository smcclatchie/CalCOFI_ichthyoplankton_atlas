// "Print to PNG" for the EDA views (2026-10-17, user): a 300 dpi PNG of the
// view's graphic part -- its title, charts, legend and note, without the page
// controls (buttons, selectors, sliders, the variable lists).
//
// The panel is rendered by html-to-image (DOM -> SVG foreignObject -> canvas)
// at PNG_DPI / 96 times its on-screen size (CSS px are 1/96 in), so the image
// prints at 300 dpi at the size it has on screen, and a pHYs chunk records
// 300 dpi in the file for print and layout software.
"use strict";

const PNG_DPI = 300;
// left out of the image: the controls, and the parts of them that only make sense on screen
const PNG_SKIP = "button, input, label, .segmented, .stepper, #xc-range-box, .xc-vars";

// CRC-32 (the PNG chunk checksum)
const pngCrcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function pngCrc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = pngCrcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The PNG with a pHYs chunk (dpi as pixels per metre) right after IHDR.
async function pngWithDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);           // "pHYs"
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;   // unit: metre
  dv.setUint32(17, pngCrc(chunk.subarray(4, 17)));
  const at = 8 + 25;                                 // signature + IHDR chunk
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at)); out.set(chunk, at); out.set(src.subarray(at), at + chunk.length);
  return new Blob([out], { type: "image/png" });
}

async function printPanelPng(button) {
  const panel = document.getElementById(button.dataset.target);
  if (!panel || typeof htmlToImage === "undefined") return;
  const label = button.textContent;
  button.disabled = true; button.textContent = "Rendering…";
  panel.classList.add("png-capture");                // atlas.css: hides the on-screen aids
  try {
    const bg = getComputedStyle(panel).backgroundColor;
    const blob = await htmlToImage.toBlob(panel, {
      pixelRatio: PNG_DPI / 96,
      skipFonts: true,                 // system fonts only; skips fetching the map library's stylesheet
      backgroundColor: bg && bg !== "rgba(0, 0, 0, 0)" ? bg : getComputedStyle(document.body).backgroundColor,
      filter: (node) => !(node instanceof Element && node.matches(PNG_SKIP)),
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await pngWithDpi(blob, PNG_DPI));
    a.download = `calcofi_atlas_${button.dataset.name}_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    console.error("Print to PNG failed", e);
    alert("Sorry, the PNG could not be made in this browser.");
  } finally {
    panel.classList.remove("png-capture");
    button.disabled = false; button.textContent = label;
  }
}

document.querySelectorAll(".png-btn").forEach((b) => b.addEventListener("click", () => printPanelPng(b)));
