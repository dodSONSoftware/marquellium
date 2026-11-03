FROM node:22-bookworm AS node
FROM rust:1.99-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf xvfb dbus-x11 xauth xdg-utils python3 webkit2gtk-driver libglib2.0-bin openbox xdotool strace scrot poppler-utils fonts-noto-cjk at-spi2-core xdg-desktop-portal xdg-desktop-portal-gtk && rm -rf /var/lib/apt/lists/*
RUN rustup component add clippy
RUN cargo install tauri-driver --version 2.1.0 --locked
RUN npm install -g pnpm@12.16.1
WORKDIR /work
