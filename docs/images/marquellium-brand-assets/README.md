# Marquellium brand assets

Vector recreation based on the approved Marquellium branding artwork. The SVGs use traced vector outlines, rather than embedded PNGs or system fonts. The script-style wordmark, gradient flourish, subtitle, and M/down-arrow artwork all originate from the approved reference.

## Assets

- `marquellium-logo-light.svg` — horizontal lockup for light surfaces; transparent canvas.
- `marquellium-logo-dark.svg` — horizontal lockup for dark surfaces; transparent canvas.
- `marquellium-icon.svg` — standalone vector app icon with transparent outer corners.
- `Marquellium.icns` — multiresolution macOS app icon.
- `Marquellium.iconset/` — icon assets compatible with macOS `iconutil`.
- `marquellium-icon-{size}.png` — PNG exports at 16, 32, 64, 128, 256, 512, and 1024 pixels.
- `marquellium-logo-{theme}-transparent.png` — transparent raster copies.
- `marquellium-logo-{theme}-preview.png` — previews against representative backgrounds.
- `marquellium-preview-sheet.png` — combined review sheet.

## Usage (Tauri / macOS)

Copy the SVG logos to your app's `public/` directory and use them as normal images. Keep both transparent variants and select based on the active theme.

For Tauri 2, provide PNG and/or ICNS files in your build configuration's `bundle.icon` array, or provide the iconset to native macOS tooling as needed.

To regenerate the macOS ICNS on a Mac, use:

```bash
iconutil -c icns Marquellium.iconset -o Marquellium.icns
```

The SVG files contain no embedded raster elements, external fonts, scripts, or background panels. The standalone icon necessarily has its own rounded gradient square, with transparent outer corners.
